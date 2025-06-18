// index.ts

import express, { Request, Response } from 'express';
import request from 'request';

const app = express();
const port = 3000;

// /search?searchValue=사다리&category=0 형태로 요청 가능
app.get('/search', (req: Request, res: Response) => {
  const { searchValue = '사다리', category = '0' } = req.query;

  const api_url = 'https://apis.data.go.kr/B552468/srch/smartSearch';
  const serviceKey = '9zazpPLTdHgqjaogVs+zXwzwqFlFWjUnUtuRzwyUtqYMOUHo3HnBXl+gvpebHMreVOqgpfA9NBDbWR0Q9hmOiQ=='; // URL 인코딩된 값

  const options = {
    url: api_url,
    qs: {
      serviceKey,
      pageNo: 1,
      numOfRows: 10,
      searchValue,
      category,
    },
  };

  request.get(options, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(body);
    } else {
      res.status(response?.statusCode || 500).json({
        error: 'API 요청 실패',
        details: error,
      });
    }
  });
});

app.listen(port, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${port}`);
});
