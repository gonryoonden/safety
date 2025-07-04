import type { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';

const KOSHA_BASE = process.env.KOSHA_API_BASE!;
const SERVICE_KEY = process.env.KOSHA_SERVICE_KEY!;

const KoshaClient = axios.create({ baseURL: KOSHA_BASE, timeout: 5000 });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { function_name, arguments: args } = req.body;

  try {
    switch (function_name) {
      case 'search_safety_law': {
        const { searchValue, category = 0, pageNo = 1, numOfRows = 10 } = args;
        if (!searchValue) {
          return res.status(400).json({ error: 'searchValue is required' });
        }
        const response = await KoshaClient.get('/smartSearch', {
          params: {
            serviceKey: SERVICE_KEY,
            searchValue,
            category,
            pageNo,
            numOfRows,
          },
        });
        const body = response.data.response.body;
        return res.status(200).json({ result: body });
      }

      case 'get_law_detail': {
        const { docId } = args;
        if (!docId) {
          return res.status(400).json({ error: 'docId is required' });
        }
        // 상세조회는 filepath 호출 권장
        return res.status(200).json({ message: 'Use filepath URL for detail', docId });
      }

      case 'generate_action_plan': {
        const { lawItems } = args;
        if (!Array.isArray(lawItems)) {
          return res.status(400).json({ error: 'lawItems array is required' });
        }
        const checklist = lawItems.map((item: any, idx: number) => ({
          step: idx + 1,
          title: item.title,
          action: `문서 확인: ${item.highlight_content}`,
          link: item.filepath,
        }));
        return res.status(200).json({ checklist });
      }

      case 'analyze_hazard': {
        const { image_url } = args;
        if (!image_url) {
          return res.status(400).json({ error: 'image_url is required' });
        }
        // 이미지 분석 로직 또는 모의 데이터
        const hazards = ['사다리', '크레인'];
        return res.status(200).json({ hazards });
      }

      default:
        return res.status(400).json({ error: `Unknown function: ${function_name}` });
    }
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
