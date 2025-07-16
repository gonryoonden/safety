import type { NextApiRequest, NextApiResponse } from 'next';
import axios, { AxiosError } from 'axios';
import NodeCache from 'node-cache';

// ---------- Env & Constants ----------
const KOSHA_BASE =
  process.env.KOSHA_API_BASE ?? 'http://apis.data.go.kr/B552468/srch';
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;
const CACHE_TTL = 600; // 10 minutes
const cache = new NodeCache({ stdTTL: CACHE_TTL });

const koshaClient = axios.create({
  baseURL: KOSHA_BASE,
  timeout: 5000,
  // HTTP only (API 자체가 HTTPS 미지원)
  httpAgent: undefined,
  httpsAgent: undefined
});

// ---------- Helpers ----------
const toSafeNumber = (v: any, def: number) =>
  Number.isFinite(+v) && +v > 0 ? +v : def;

function mapOpenApiError(code: string) {
  // 일부 주요 코드 매핑
  switch (code) {
    case '22': // LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR
      return { status: 429, msg: '일일 호출 한도를 초과했습니다.' };
    case '30': // SERVICE_KEY_IS_NOT_REGISTERED_ERROR
      return { status: 401, msg: '등록되지 않은 서비스 키입니다.' };
    case '31': // DEADLINE_HAS_EXPIRED_ERROR
      return { status: 403, msg: 'API 활용 기간이 만료되었습니다.' };
    default:
      return { status: 502, msg: 'KOSHA API 오류가 발생했습니다.' };
  }
}

function slim(items: any[]) {
  return items.map((it) => ({
    doc_id: it.doc_id,
    title: it.title,
    category: it.category,
    filepath: it.filepath,
    content_snippet: it.highlight_content ?? it.content
  }));
}

// ---------- Handler ----------
export const config = { api: { bodyParser: true } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'POST only' });
  }

  const { function_name, arguments: args = {} } = req.body ?? {};

  if (!function_name) {
    return res.status(400).json({ error: '`function_name` is required.' });
  }

  // 기본 파라미터 보정
  args.pageNo = toSafeNumber(args.pageNo, 1);
  args.numOfRows = toSafeNumber(args.numOfRows, 10);
  args.category = toSafeNumber(args.category, 0);

  try {
    switch (function_name) {
      /* ---------- 1) 스마트 검색 ---------- */
      case 'search_safety_law': {
        const { searchValue, category, pageNo, numOfRows } = args as {
          searchValue?: string;
          category: number;
          pageNo: number;
          numOfRows: number;
        };
        if (!searchValue)
          return res
            .status(400)
            .json({ error: '`searchValue` is required.' });

        // 캐시 키
        const key = `${searchValue}|${category}|${pageNo}|${numOfRows}`;
        const cached = cache.get(key);
        if (cached) {
          return res.status(200).json({ ...cached, fromCache: true });
        }

        const { data } = await koshaClient.get('/smartSearch', {
          params: {
            serviceKey: SERVICE_KEY,
            searchValue,
            category,
            pageNo,
            numOfRows
          },
          transitional: { clarifyTimeoutError: true }
        });

        // 오류 코드 변환
        const openApiCode = data?.response?.header?.resultCode;
        if (openApiCode !== '00') {
          const mapped = mapOpenApiError(openApiCode);
          return res.status(mapped.status).json({ error: mapped.msg });
        }

        const body = data.response.body;
        const lite = {
          totalCount: body.totalCount,
          pageNo: body.pageNo,
          numOfRows: body.numOfRows,
          items: slim(body.items.item ?? []),
          lastRefresh: new Date().toISOString()
        };
        cache.set(key, lite);
        return res.status(200).json(lite);
      }

      /* ---------- 2) 요약 ---------- */
      case 'summarize_law_snippets': {
        const { snippets } = args as { snippets?: string[] };
        if (!Array.isArray(snippets) || snippets.length === 0) {
          return res
            .status(400)
            .json({ error: '`snippets` 배열이 필요합니다.' });
        }
        // ⬇️  실제 서비스에선 OpenAI 호출; 데모용 간단 합치기
        const summary = snippets.slice(0, 10).join(' / ');
        return res.status(200).json({ summary });
      }

      /* ---------- 3) 개선활동 체크리스트 ---------- */
      case 'generate_action_plan': {
        const { summary } = args as { summary?: string };
        if (!summary) {
          return res
            .status(400)
            .json({ error: '`summary` 필드가 필요합니다.' });
        }
        return res.status(200).json({
          checklist: summary.split(/\.|\n/).filter(Boolean).map((s, i) => ({
            step: i + 1,
            action: s.trim()
          }))
        });
      }

      default:
        return res.status(400).json({ error: 'Unknown function.' });
    }
  } catch (err) {
    const e = err as AxiosError;
    if (e.isAxiosError && e.response?.data?.response?.header?.resultCode) {
      const mapped = mapOpenApiError(
        e.response.data.response.header.resultCode
      );
      return res.status(mapped.status).json({ error: mapped.msg });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

