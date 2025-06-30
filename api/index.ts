import express, { Request, Response } from 'express';
import request from 'request';

const app = express();
const port = process.env.PORT || 3000;
const serviceKey = process.env.SERVICE_KEY;

if (!serviceKey) {
  console.error('SERVICE_KEY가 설정되지 않았습니다.');
  process.exit(1);
}

// 단일 /searchGuidelines 라우트에 풀 스펙 프록시
app.get('/search', (req: Request, res: Response) => {
  const {
    pageNo = '1',
    numOfRows = '10',
    searchValue = '',
    category,
  } = req.query;

  const qs: any = { serviceKey, pageNo, numOfRows, searchValue };
  if (category !== undefined) qs.category = category;

  const options = {
    url: 'https://safety-umber.vercel.app/searchGuidelines',
    qs,
  };

  request.get(options, (err, response, body) => {
    if (!err && response.statusCode === 200) {
      res.header('Content-Type', 'application/json; charset=utf-8');
      res.send(body);
    } else {
      res
        .status(response?.statusCode || 500)
        .json({ error: 'API 요청 실패', details: err });
    }
  });
});

app.listen(port, () => {
  console.log(`서버 실행 중: http://localhost:${port}`);
  console.log(`  • /search (통합 스마트검색)`);
});
