// api/search.ts

import { NowRequest, NowResponse } from '@vercel/node';
import request from 'request';

export default function handler(req: NowRequest, res: NowResponse) {
  const serviceKey = process.env.SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: 'SERVICE_KEY 미설정' });
  }

  const { pageNo = '1', numOfRows = '10', searchValue = '', category } = req.query;
  const qs: any = { serviceKey, pageNo, numOfRows, searchValue };
  if (category !== undefined) qs.category = category;

  request.get(
    { url: 'https://apis.data.go.kr/B552468/srch/smartSearch', qs },
    (err, response, body) => {
      if (!err && response.statusCode === 200) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(body);
      } else {
        res
          .status(response?.statusCode || 500)
          .json({ error: 'API 요청 실패', details: err });
      }
    }
  );
}
