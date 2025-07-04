import type { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

// Next.js의 body 파서를 사용하도록 설정
export const config = {
  api: {
    bodyParser: true
  }
};

const KOSHA_BASE = process.env.KOSHA_API_BASE!;
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;

// 재사용을 위한 axios 클라이언트 인스턴스 생성
const koshaClient = axios.create({
  baseURL: KOSHA_BASE,
  timeout: 5000
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 1. POST 요청만 허용
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res
      .status(405)
      .json({ error: 'Method Not Allowed. Please use POST.' });
  }

  const { function_name, arguments: args } = req.body ?? {};

  // 2. function_name 존재 여부 확인
  if (!function_name) {
    return res
      .status(400)
      .json({ error: '`function_name` is required in the request body.' });
  }

  // 3. [핵심 수정] arguments 객체 존재 및 타입 확인
  if (!args || typeof args !== 'object') {
    return res.status(400).json({
      error: `The 'arguments' object is missing or invalid for function: ${function_name}.`
    });
  }

  try {
    switch (function_name) {
      // 스마트 검색
      case 'search_safety_law': {
        const { searchValue } = args as { searchValue?: string };
        // 4. 함수별 필수 인자 추가 검증
        if (!searchValue) {
          return res.status(400).json({
            error: '`searchValue` is required in arguments for search_safety_law.'
          });
        }
        
        // serviceKey는 서버에서 추가하고, 나머지 args를 그대로 전달
        const response = await koshaClient.get('/smartSearch', {
          params: { serviceKey: SERVICE_KEY, ...args }
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
            .json({ error: '`docId` is required for get_law_detail.' });
        }
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
            .json({ error: '`lawItems` array is required.' });
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
            .json({ error: '`image_url` is required for analyze_hazard.' });
        }
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
    console.error(`[Handler Error for ${function_name}]:`, error);

    // 외부 API(axios) 호출 에러인 경우, 해당 에러 정보를 반환하면 디버깅에 용이
    if (axios.isAxiosError(error) && error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    // 그 외 서버 내부 에러
    return res
      .status(500)
      .json({ error: error.message || 'Internal Server Error' });
  }
}
