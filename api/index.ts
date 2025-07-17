import type { NextApiRequest, NextApiResponse } from 'next'; 
import axios, { AxiosError } from 'axios';

// ---------- Env & Constants ----------
const KOSHA_BASE =
  process.env.KOSHA_API_BASE ?? 'http://apis.data.go.kr/B552468/srch';
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;

const koshaClient = axios.create({
  baseURL: KOSHA_BASE,
  timeout: 5000,
});

// --- [피드백 1] 타입 정의 및 헬퍼 함수 추가 ---
/** KOSHA API 원본 응답의 item 타입 */
interface KoshaItemRaw {
  doc_id: string;
  title: string;
  highlight_content?: string;
  content?: string;
  filepath?: string;
  category: string;
  keyword: string;
}

/** GPT Actions에 최종적으로 전달할, 가공된 법령 정보 타입 */
interface LawSearchItem {
  docId: string;
  title: string;
  summary: string;
  link: string | null;
  category: string;
  keywords: string[];
}

/**
 * KOSHA API의 원본 응답 배열을 GPT가 사용하기 쉬운 형태로 정규화합니다.
 * @param rawItems - KOSHA API의 items.item 배열
 * @returns 가공된 LawSearchItem 객체 배열
 */
const normalizeItems = (rawItems: any): LawSearchItem[] => {
  // 결과가 1건일 때 객체로, 2건 이상일 때 배열로 오는 경우를 모두 처리
  const list = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  
  return (list as KoshaItemRaw[]).map(item => ({
    docId: item.doc_id,
    title: item.title,
    // highlight_content가 없으면 content를 사용하고, HTML 태그 제거
    summary: (item.highlight_content ?? item.content ?? '').replace(/<[^>]*>/g, ''),
    // filepath를 명확한 link 키로 매핑
    link: item.filepath ?? null,
    category: item.category,
    keywords: item.keyword ? item.keyword.split(',').map(k => k.trim()) : [],
  }));
};
// --- [피드백 1] 종료 ---


// ---------- Helpers ----------
const toSafeNumber = (v: any, def: number) =>
  Number.isFinite(+v) && +v > 0 ? +v : def;

function mapOpenApiError(code: string) {
  switch (code) {
    case '22':
      return { status: 429, msg: '일일 API 호출 한도를 초과했습니다.' };
    case '30':
      return { status: 401, msg: '등록되지 않은 서비스 키입니다.' };
    case '31':
      return { status: 403, msg: 'API 활용 기간이 만료되었습니다.' };
    default:
      return { status: 502, msg: 'KOSHA API 서버에서 오류가 발생했습니다.' };
  }
}

// ---------- Handler ----------
export const config = { api: { bodyParser: true } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'POST 메서드만 허용됩니다.' });
  }

  const { function_name, arguments: args = {} } = req.body ?? {};

  if (!function_name) {
    return res.status(400).json({ error: 'function_name은 필수 항목입니다.' });
  }

  // 기본 파라미터 보정
  args.pageNo = toSafeNumber(args.pageNo, 1);
  args.numOfRows = toSafeNumber(args.numOfRows, 10);

  try {
    switch (function_name) {
      /* ---------- 1) 스마트 검색 ---------- */
      // --- [피드백 2] search_safety_law 분기 교체 ---
      case 'search_safety_law': {
        const { searchValue } = args as { searchValue?: string };
        if (!searchValue) {
          return res.status(400).json({ error: 'searchValue는 필수 항목입니다.' });
        }

        const { data } = await koshaClient.get('/smartSearch', {
          params: { serviceKey: SERVICE_KEY, ...args },
        });

        const header = data?.response?.header;
        const body = data?.response?.body;

        // API 자체의 에러 코드 처리
        if (header?.resultCode !== '00') {
          const mapped = mapOpenApiError(header?.resultCode);
          return res.status(mapped.status).json({ error: mapped.msg, details: header });
        }
        
        // 정규화 헬퍼 함수를 사용하여 데이터 가공
        const items = normalizeItems(body?.items?.item);

        return res.status(200).json({
          total: body?.totalCount ?? items.length,
          associated: body?.associated_word ?? [],
          items, // 가공된 데이터를 items 키로 전달
        });
      }
      // --- [피드백 2] 종료 ---

      /* ---------- 2) 요약 (기존과 동일) ---------- */
      case 'summarize_law_snippets': {
        const { snippets } = args as { snippets?: string[] };
        if (!Array.isArray(snippets) || snippets.length === 0) {
          return res.status(400).json({ error: 'snippets 배열이 필요합니다.' });
        }
        const summary = snippets.slice(0, 10).join(' / ');
        return res.status(200).json({ summary });
      }

      /* ---------- 3) 개선활동 체크리스트 ---------- */
      // --- [피드백 3] generate_action_plan 내부 키 변경 ---
      case 'generate_action_plan': {
        const { lawItems } = args as { lawItems?: LawSearchItem[] };
        if (!Array.isArray(lawItems) || lawItems.length === 0) {
          return res.status(400).json({ error: 'lawItems 배열이 필요합니다.' });
        }
        
        // lawItems 배열을 기반으로 체크리스트 생성
        const checklist = lawItems.map((item, idx) => ({
          step: idx + 1,
          title: item.title,
          action: 문서 확인: ${item.summary},
          // search_safety_law에서 가공된 link 키를 사용
          link: item.link 
        }));

        return res.status(200).json({ checklist });
      }
      // --- [피드백 3] 종료 ---

      default:
        return res.status(400).json({ error: 알 수 없는 함수입니다: ${function_name} });
    }
  } catch (err) {
    const e = err as AxiosError;
    // Axios 에러 및 공공데이터 포털 게이트웨이 에러 처리
    if (e.isAxiosError && e.response?.data?.response?.header?.resultCode) {
      const mapped = mapOpenApiError(e.response.data.response.header.resultCode);
      return res.status(mapped.status).json({ error: mapped.msg });
    }
    console.error([API Route Error: ${function_name}], err);
    return res.status(500).json({ error: '내부 서버 오류가 발생했습니다.' });
  }
}
