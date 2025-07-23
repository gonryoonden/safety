import type { NextApiRequest, NextApiResponse } from 'next';
import axios, { AxiosError } from 'axios';
import NodeCache from 'node-cache';
import axiosRetry from 'axios-retry';

/* ───────── Env & Constants ───────── */
const KOSHA_BASE =
  process.env.KOSHA_API_BASE ?? 'http://apis.data.go.kr/B552468/srch';
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;
const CACHE_TTL = 600; // 10 min

const cache = new NodeCache({ stdTTL: CACHE_TTL });
const koshaClient = axios.create({ baseURL: KOSHA_BASE, timeout: 5000 });

axiosRetry(koshaClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (e) =>
    axiosRetry.isNetworkError(e) ||
    [502, 503, 504].includes(e.response?.status ?? 0) ||
    e.response?.data === '\n'
});

/* ───────── Simple Circuit Breaker ───────── */
let failureCount = 0;
let circuitOpenUntil = 0;

/* ───────── Types ───────── */
interface KoshaBodyItem {
  doc_id: string;
  title: string;
  category: string;
  filepath?: string;
  content: string;
  highlight_content?: string;
  image_path?: string[];
  keyword?: string;
  med_thumb_yn?: string;
  media_style?: string;
  score?: number;
}

interface KoshaBody {
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  items?: { item?: KoshaBodyItem[] };
  total_media?: KoshaBodyItem[];
}

interface KoshaApiResponse {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: KoshaBody;
  };
}

interface SlimItem {
  doc_id: string;
  title: string;
  category: string;
  filepath: string; // [수정] optional이 아닌 필수로 변경
  content_snippet: string;
  score?: number;
}

/* ───────── Helpers ───────── */
const categoryToLawNameMap: { [key: string]: string } = {
  '1': '산업안전보건법',
  '2': '산업안전보건법 시행령',
  '3': '산업안전보건법 시행규칙',
  '4': '산업안전보건기준에관한규칙',
  '8': '중대재해처벌법',
  '9': '중대재해처벌법 시행령',
  '11': '유해위험작업의 취업제한에 관한 규칙',
};

function splitTitle(t: string) {
  const m = t.match(/제\s*(\d+)\s*조/);
  const lawName = t.replace(/제\s*(\d+)\s*조.*$/, '').trim();
  return { article: m?.[1], inferredLawName: lawName };
}

function buildLawUrl(item: KoshaBodyItem): string | undefined {
  const cat = item.category;
  const { article, inferredLawName } = splitTitle(item.title);

  let lawName: string | undefined;
  let prefix: '법령' | '행정규칙' | null = null;

  if (categoryToLawNameMap[cat]) {
    lawName = categoryToLawNameMap[cat];
    prefix = '법령';
  } else if (cat === '5') {
    lawName = inferredLawName;
    prefix = '행정규칙';
  }

  if (!lawName || !prefix) {
    return undefined;
  }

  const encodedName = encodeURIComponent(lawName);
  const articlePath = article ? `/제${article}조` : '';

  return `https://www.law.go.kr/${prefix}/${encodedName}${articlePath}`;
}

const toSafeNumber = (v: any, def: number) =>
  Number.isFinite(+v) && +v > 0 ? +v : def;

// [수정] 유효성 검사 함수
const isValidUrl = (urlString?: string): boolean => {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

// [수정] 데이터 손실을 막기 위한 폴백 로직 추가
const resolveFilepath = (item: KoshaBodyItem): string | undefined => {
  const lawUrl = buildLawUrl(item);
  if (lawUrl) return lawUrl;

  if (isValidUrl(item.filepath)) {
    return item.filepath;
  }

  return undefined;
};

// [수정] 안전한 필터링 로직으로 개선
const slim = (items: KoshaBodyItem[]): SlimItem[] => {
  return items
    .map((it) => {
      const snippet = it.highlight_content ?? it.content ?? '';
      const resolvedPath = resolveFilepath(it);

      if (!resolvedPath || !snippet) {
        return null;
      }

      return {
        doc_id: it.doc_id,
        title: it.title,
        category: it.category,
        filepath: resolvedPath,
        content_snippet: snippet,
        score: it.score,
      };
    })
    .filter((i): i is SlimItem => i !== null);
};


const mapOpenApiError = (code: string) => {
  switch (code) {
    case '22': return { status: 429, msg: '일일 호출 한도를 초과했습니다.' };
    case '30': return { status: 401, msg: '등록되지 않은 서비스 키입니다.' };
    case '31': return { status: 403, msg: 'API 활용 기간이 만료되었습니다.' };
    case '40': return { status: 400, msg: '페이지 번호는 0보다 커야 합니다.' };
    case '42': return { status: 500, msg: 'KOSHA API 내부 오류가 발생했습니다.' };
    case '45': return { status: 403, msg: '잘못된 접근입니다 (게이트웨이).' };
    default: return { status: 502, msg: `KOSHA API 오류 (code ${code})` };
  }
};

/* ───────── API Route Config ───────── */
export const config = { api: { bodyParser: true } };

/* ───────── Handler ───────── */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });

  if (Date.now() < circuitOpenUntil)
    return res
      .status(503)
      .json({ error: 'KOSHA API temporarily suspended (circuit open).' });

  const { function_name, arguments: args = {} } = req.body ?? {};
  if (!function_name)
    return res.status(400).json({ error: '`function_name` is required.' });

  args.pageNo = toSafeNumber(args.pageNo, 1);
  args.numOfRows = toSafeNumber(args.numOfRows, 10);
  args.category = toSafeNumber(args.category, 0);

  try {
    switch (function_name) {
      /* ───── 스마트검색 ───── */
      case 'search_safety_law': {
        const { searchValue, category, pageNo, numOfRows } = args as {
          searchValue?: string;
          category: number;
          pageNo: number;
          numOfRows: number;
        };

        if (!searchValue)
          return res.status(400).json({ error: '`searchValue` is required.' });

        const key = `${searchValue}|${category}|${pageNo}|${numOfRows}`;
        const cached = cache.get(key);
        if (cached) return res.status(200).json(cached);

        // [수정] 에러 처리를 위해 전체 응답을 받도록 변경
        const response = await koshaClient.get('/smartSearch', {
          params: {
            serviceKey: SERVICE_KEY,
            searchValue,
            category,
            pageNo,
            numOfRows,
            dataType: 'JSON'
          },
          transitional: { clarifyTimeoutError: true },
          validateStatus: () => true // 모든 HTTP 상태 코드를 .then()으로 전달
        });

        // [추가] XML 응답(게이트웨이 에러)을 먼저 확인 (라이브러리 없이)
        const contentType = response.headers['content-type'] ?? '';
        if (contentType.includes('xml')) {
            return res.status(401).json({
                error: 'KOSHA API Gateway 오류가 발생했습니다. 서비스 키 또는 호출 한도를 확인하세요.'
            });
        }
        
        // [추가] 비정상 HTTP 상태 코드 처리
        if (response.status !== 200) {
            return res.status(502).json({ 
                error: `KOSHA API가 비정상 상태 코드(${response.status})를 반환했습니다.` 
            });
        }

        // [수정] 응답 데이터 변수명 변경 (response.data -> api)
        const api = response.data as KoshaApiResponse;
        if (api.response.header.resultCode !== '00') {
          const mapped = mapOpenApiError(api.response.header.resultCode);
          return res.status(mapped.status).json({ error: mapped.msg });
        }

        if (!api?.response?.body) {
          return res.status(502).json({ error: 'KOSHA API에서 비정상 응답이 반환되었습니다.' });
        }

        const items: KoshaBodyItem[] = [
          ...(api.response.body.items?.item ?? []),
          ...(api.response.body.total_media ?? [])
        ];

        const lite = {
          totalCount: api.response.body.totalCount,
          pageNo: api.response.body.pageNo,
          numOfRows: api.response.body.numOfRows,
          items: slim(items),
          lastRefresh: new Date().toISOString()
        };

        if (lite.items.length)
          cache.set(key, lite);
        else cache.del(key); 

        failureCount = 0;
        return res.status(200).json(lite);
      }

      /* ───── 기타 함수 (예시) ───── */
      case 'summarize_law_snippets': {
        const { snippets } = args as { snippets?: string[] };
        if (!Array.isArray(snippets) || !snippets.length)
          return res.status(400).json({ error: 'snippets 배열 필요' });
        return res
          .status(200)
          .json({ summary: snippets.slice(0, 10).join(' / ') });
      }

      default:
        return res.status(400).json({ error: 'Unknown function.' });
    }
  } catch (err) {
    failureCount++;
    if (failureCount >= 5) {
      circuitOpenUntil = Date.now() + 60_000;
      failureCount = 0;
      console.warn('Circuit opened for 60 s due to repeated failures.');
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
