import type { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

export const config = {
  api: {
    bodyParser: true
  }
};

const KOSHA_BASE = process.env.KOSHA_API_BASE!;
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;

const koshaClient = axios.create({
  baseURL: KOSHA_BASE,
  timeout: 5000
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 1) POST 아닌 요청 차단
  if (req.method !== 'POST') {
    return res
      .status(405)
      .json({ error: 'Method Not Allowed. Please use POST.' });
  }

  // 2) body가 비어 있을 때 대비
  const { function_name, arguments: args } = req.body ?? {};

  // 3) function_name 유효성 체크
  if (!function_name) {
    return res
      .status(400)
      .json({ error: 'function_name is required in the request body.' });
  }

  try {
    switch (function_name) {
      // 스마트 검색
      case 'search_safety_law': {
        const {
          searchValue,
          category = 0,
          pageNo = 1,
          numOfRows = 10
        } = args as {
          searchValue?: string;
          category?: number;
          pageNo?: number;
          numOfRows?: number;
        };

        if (!searchValue) {
          return res
            .status(400)
            .json({ error: 'searchValue is required for search_safety_law.' });
        }

        const response = await koshaClient.get('/smartSearch', {
          params: {
            serviceKey: SERVICE_KEY,
            searchValue,
            category,
            pageNo,
            numOfRows
          }
        });

        const body = response.data?.response?.body;
        return res.status(200).json({ result: body });
      }

      // 상세 조회
      case 'get_law_detail': {
        const { docId } = args as { docId?: string };
        if (!docId) {
          return res
            .status(400)
            .json({ error: 'docId is required for get_law_detail.' });
        }
        // 가이드: filepath URL을 통해 상세 문서 조회
        return res.status(200).json({
          message: 'Use the filepath URL from search results to fetch detail.',
          docId
        });
      }

      // 개선활동 체크리스트 생성
      case 'generate_action_plan': {
        const { lawItems } = args as { lawItems?: any[] };
        if (!Array.isArray(lawItems)) {
          return res
            .status(400)
            .json({ error: 'lawItems array is required.' });
        }

        const checklist = lawItems.map((item, idx) => ({
          step: idx + 1,
          title: item.title,
          action: `문서 확인: ${item.highlight_content}`,
          link: item.filepath
        }));

        return res.status(200).json({ checklist });
      }

      // 위험요인 분석
      case 'analyze_hazard': {
        const { image_url } = args as { image_url?: string };
        if (!image_url) {
          return res
            .status(400)
            .json({ error: 'image_url is required for analyze_hazard.' });
        }

        // TODO: 실제 Vision API 연동 로직 추가
        const hazards = ['사다리', '크레인']; // 임시 샘플 데이터
        return res.status(200).json({ hazards });
      }

      // 알 수 없는 함수 호출
      default:
        return res
          .status(400)
          .json({ error: `Unknown function: ${function_name}` });
    }
  } catch (error: any) {
    console.error('[handler error]', error);
    return res
      .status(500)
      .json({ error: error.message || 'Internal Server Error' });
  }
}
