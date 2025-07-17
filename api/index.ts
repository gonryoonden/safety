import type { NextApiRequest, NextApiResponse } from 'next';
import axios, { AxiosError } from 'axios';
import NodeCache from 'node-cache';

// ---------- Env & Constants ----------
const KOSHA_BASE =
  process.env.KOSHA_API_BASE ?? 'http://apis.data.go.kr/B552468/srch';
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;
const CACHE_TTL = 600; // 10 minutes (데이터 갱신주기 월 1회 감안 시 더 길게 고려 가능)
const cache = new NodeCache({ stdTTL: CACHE_TTL });
const koshaClient = axios.create({
  baseURL: KOSHA_BASE,
  timeout: 5000,
  // HTTP only (API 자체가 HTTPS 미지원) - 가이드와 일치 [11]
  httpAgent: undefined,
  httpsAgent: undefined,
});

// ---------- Types ----------
// 이유: KOSHA API 응답 구조를 명확히 하고 타입 안정성을 확보
interface KoshaHeader {
  resultCode: string;
  resultMsg: string;
}

interface KoshaBodyItem {
  doc_id: string;
  title: string;
  category: string;
  filepath: string;
  content: string;
  highlight_content?: string;
  // 가이드에 따라 필요한 다른 필드 추가 가능 (e.g., image_path, keyword, med_thumb_yn, media_style, score)
}

interface KoshaBody {
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  items?: {
    item?: KoshaBodyItem[]; // 법령 관련 문서 목록
  };
  total_media?: KoshaBodyItem[]; // 미디어/첨부파일 목록
  // 가이드에 따라 필요한 다른 body 필드 추가 (e.g., associated_word, categorycount, dataType)
}

interface KoshaApiResponse {
  response: {
    header: KoshaHeader;
    body: KoshaBody;
  };
}

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
    case '40': // PAGE_NO_ZERO (제공기관 에러코드)
        return { status: 400, msg: '페이지 번호는 0보다 커야 합니다.' };
    case '32': // UNREGISTERED_IP_ERROR (공공데이터 포털 에러코드)
        return { status: 403, msg: '등록되지 않은 IP에서의 요청입니다.' };
    default:
      // KOSHA API 오류 코드 중 불명확한 경우 (예: 42, 45 등) [10]
      // 또는 Axios 오류가 KOSHA API 오류로 매핑되지 못한 경우
      return { status: 502, msg: 'KOSHA API 오류가 발생했습니다.' };
  }
}

// 이유: filepath가 유효한 URL 형태인지 검사하는 헬퍼 함수 추가
const isValidUrl = (url: string | undefined): boolean => {
  if (!url || url.length === 0) return false;
  try {
    const parsedUrl = new URL(url);
    // KOSHA 가이드에 따라 HTTP도 허용 [11]
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
};

// 이유: slim 함수 개선 - filepath 유효성 검사 및 <!-- inv_blank --> 필터링, 결과 통합
function slim(items: KoshaBodyItem[]) { // 타입 명시
  return items.map((it) => ({
    doc_id: it.doc_id,
    title: it.title,
    category: it.category,
    // 이유: 유효하지 않은 filepath는 undefined로 처리하여 클라이언트에서 빈 페이지 오류 방지
    filepath: isValidUrl(it.filepath) ? it.filepath : undefined,
    // 이유: <!-- inv_blank -->는 실제 내용이 없음을 의미하므로 빈 문자열로 처리
    content_snippet: it.highlight_content?.includes('<!-- inv_blank -->') || it.content?.includes('<!-- inv_blank -->')
      ? ''
      : it.highlight_content ?? it.content,
  })).filter(it => it.filepath && it.content_snippet !== ''); // 이유: 유효한 filepath가 없고 내용이 비어있는 항목 필터링
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

        let apiResponseData: KoshaApiResponse;
        try {
          const { data } = await koshaClient.get<KoshaApiResponse>('/smartSearch', {
            params: {
              serviceKey: SERVICE_KEY,
              searchValue,
              category,
              pageNo,
              numOfRows,
            },
            transitional: { clarifyTimeoutError: true },
            // 이유: 4xx 응답도 AxiosError로 던지지 않고 response로 받아 직접 처리
            validateStatus: (status) => status >= 200 && status < 500,
          });
          apiResponseData = data;
        } catch (axiosErr) {
          // 이유: Axios 자체 오류 (네트워크, 타임아웃, 응답 본문 비정상 등) 처리
          const e = axiosErr as AxiosError;
          if (e.isAxiosError && e.response) {
            // 이유: KOSHA API가 아닌 중간 프록시나 네트워크 계층에서 반환된 빈 응답 (response_data: "\n") 처리
            if (e.response.data === '\n') {
                console.error("KOSHA API returned a malformed empty response (newline character).");
                return res.status(502).json({ error: 'KOSHA API에서 비정상적인 응답이 반환되었습니다. (내용 없음)' });
            }
            // 이유: KOSHA API에서 에러코드를 반환했으나 Axios Error로 잡힌 경우 (validateStatus로 인해)
            if (e.response.data?.response?.header?.resultCode) {
              const mapped = mapOpenApiError(e.response.data.response.header.resultCode);
              return res.status(mapped.status).json({ error: mapped.msg });
            }
          }
          console.error('KOSHA API 호출 중 네트워크 오류 또는 예상치 못한 Axios 오류:', e);
          return res.status(500).json({ error: 'KOSHA API 호출 중 네트워크 오류가 발생했습니다.' });
        }

        // 이유: KOSHA API 응답 헤더 및 바디 유효성 검사
        if (!apiResponseData?.response?.header || !apiResponseData.response.body) {
          console.error('KOSHA API에서 예상치 못한 응답 구조가 반환되었습니다:', apiResponseData);
          return res.status(502).json({ error: 'KOSHA API에서 예상치 못한 응답 구조가 반환되었습니다.' });
        }

        // 오류 코드 변환
        const openApiCode = apiResponseData.response.header.resultCode;
        if (openApiCode !== '00') {
          const mapped = mapOpenApiError(openApiCode);
          return res.status(mapped.status).json({ error: mapped.msg });
        }

        const body = apiResponseData.response.body;

        // 이유: total_media와 items.item을 모두 포함하여 처리 (중복 제거)
        const allItems: KoshaBodyItem[] = [];
        if (body.items?.item) {
          allItems.push(...body.items.item);
        }
        if (body.total_media) { // KOSHA API 가이드에 total_media가 body 바로 아래에 있음을 명시 [2]
          allItems.push(...body.total_media);
        }

        // 이유: doc_id를 기준으로 중복 제거 (두 목록에 같은 문서가 있을 수 있음)
        const uniqueItemsMap = new Map<string, KoshaBodyItem>();
        for (const item of allItems) {
          if (!uniqueItemsMap.has(item.doc_id)) {
            uniqueItemsMap.set(item.doc_id, item);
          }
        }
        const combinedAndUniqueItems = Array.from(uniqueItemsMap.values());

        const lite = {
          totalCount: body.totalCount,
          pageNo: body.pageNo,
          numOfRows: body.numOfRows,
          items: slim(combinedAndUniqueItems), // 이유: 통합되고 필터링된 항목에 slim 함수 적용
          lastRefresh: new Date().toISOString(),
        };

        // 이유: 유효한 결과가 없는 경우에도 캐시할지 여부는 정책에 따라 결정. 일단 캐시 유지.
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
        // ⬇️ 실제 서비스에선 OpenAI 호출; 데모용 간단 합치기
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
    // 이유: 이미 `try` 블록 내에서 대부분의 Axios 및 KOSHA API 에러를 처리하므로,
    // 이 `catch` 블록은 예상치 못한, 정말 내부적인 서버 에러를 잡도록 합니다.
    if (e.isAxiosError && e.response?.data?.response?.header?.resultCode) {
      const mapped = mapOpenApiError(e.response.data.response.header.resultCode);
      return res.status(mapped.status).json({ error: mapped.msg });
    }
    console.error('Unhandled server error:', err); // 이유: catch 블록 로그 메시지 명확화
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
