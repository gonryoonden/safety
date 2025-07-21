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
  filepath?: string;
  content_snippet: string;
  score?: number;
}

/* ───────── Helpers ───────── */
// ───── 법령·행정규칙 한글주소 생성 Helper Functions ─────
function splitTitle(t: string) {
  // "제XX조" 부분을 매칭하여 조항 번호와 순수 법령명 분리
  const m = t.match(/제\s*(\d+)\s*조/);
  return { article: m?.[1], lawName: t.replace(/제\s*(\d+)\s*조.*$/, '').trim() };
}

function buildLawUrl(item: KoshaBodyItem): string | undefined {
  const { lawName, article } = splitTitle(item.title);
  if (!lawName) return undefined;

  const cat = item.category;
  // 카테고리 값에 따라 law.go.kr 경로의 접두어(prefix) 결정
  const prefix = ['5'].includes(cat) ? '행정규칙'
               : ['1','2','3','4','8','9','11'].includes(cat) ? '법령'
               : null;

  // 법령/행정규칙에 해당하지 않으면 URL 생성 안 함
  if (!prefix) return undefined;

  const encodedName = encodeURIComponent(lawName);
  const articlePath = article ? `/제${article}조` : '';

  return `https://www.law.go.kr/${prefix}/${encodedName}${articlePath}`;
}
const toSafeNumber = (v: any, def: number) =>
  Number.isFinite(+v) && +v > 0 ? +v : def;

const isValidUrl = (u?: string) => {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
};

const resolveFilepath = (item: KoshaBodyItem): string | undefined => {
  // 1️⃣ law.go.kr / 행정규칙 한글주소 우선 생성
  const lawUrl = buildLawUrl(item);
  if (lawUrl) return lawUrl;

  // 2️⃣ KOSHA API가 내려준 완전한 URL이면 그대로 반환
  if (isValidUrl(item.filepath)) return item.filepath;

  // 3️⃣ Fallback: KOSHA 내부 콘텐츠(미디어, 가이드 등) 처리
  const docId = encodeURIComponent(item.doc_id);
  // 카테고리 6(미디어)와 7(가이드)은 KOSHA 내부 콘텐츠로 함께 처리
  const isMediaOrGuide = ['6', '7'].includes(item.category);

  return isMediaOrGuide
    // 미디어/가이드는 aicuration 경로를 사용 (medSeq 파라미터 사용 권장)
    ? `https://kosha.or.kr/aicuration/index.do?mode=detail&medSeq=${docId}` 
    // 그 외 법령/규칙 등은 viewer 경로 사용
    : `https://kosha.or.kr/kosha/viewer/lawDetail.do?docId=${docId}`;
};

const slim = (items: KoshaBodyItem[]): SlimItem[] => {
  const INV = '<!-- inv_blank -->';
  return items
    .map((it) => {
      const snippetSrc = it.highlight_content ?? it.content ?? '';
      const snippet = snippetSrc.includes(INV) ? '' : snippetSrc;
      return {
        doc_id: it.doc_id,
        title: it.title,
        category: it.category,
        filepath: resolveFilepath(it),
        content_snippet: snippet,
        score: it.score
      };
    })
    .filter((i) => i.filepath && i.content_snippet !== '');
};

const mapOpenApiError = (code: string) => {
  switch (code) {
    case '22':
      return { status: 429, msg: '일일 호출 한도를 초과했습니다.' };
    case '30':
      return { status: 401, msg: '등록되지 않은 서비스 키입니다.' };
    case '31':
      return { status: 403, msg: 'API 활용 기간이 만료되었습니다.' };
    case '40':
      return { status: 400, msg: '페이지 번호는 0보다 커야 합니다.' };
    default:
      return { status: 502, msg: `KOSHA API 오류 (code ${code})` };
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

        const { data } = await koshaClient.get('/smartSearch', {
          params: {
            serviceKey: SERVICE_KEY,
            searchValue,
            category,
            pageNo,
            numOfRows,
            dataType: 'JSON' // 명시
          },
          transitional: { clarifyTimeoutError: true },
          validateStatus: (s) => s >= 200 && s < 500
        });

        if (typeof data !== 'object' || !data?.response?.body)
          return res
            .status(502)
            .json({ error: 'KOSHA API에서 비정상 응답이 반환되었습니다.' });

        const api = data as KoshaApiResponse;
        if (api.response.header.resultCode !== '00') {
          const mapped = mapOpenApiError(api.response.header.resultCode);
          return res.status(mapped.status).json({ error: mapped.msg });
        }

        // 문서·미디어 합치기
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
        else cache.del(key); // 빈 결과 캐시 안 함

        failureCount = 0; // 성공 → 실패 카운터 초기화
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
