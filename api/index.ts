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
  if (isValidUrl(item.filepath)) return item.filepath;
  const isMedia = Number(item.category) === 6;
  const docId = encodeURIComponent(item.doc_id);
  return isMedia
    ? `https://kosha.or.kr/aicuration/index.do?mode=detail&medSeq=${docId}`
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
