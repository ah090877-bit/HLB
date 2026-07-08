// api/index.js
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Vercel 환경변수에서 구글 마스터키 불러오기
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});

// 테스트용 (서버 살아있는지 확인)
app.get('/api', (req, res) => {
  res.send('백엔드 서버 쌩쌩하게 구동 중! 🚀');
});

// 클라이언트(index.html)에서 보내는 요청 처리
app.post('/api/action', async (req, res) => {
  try {
    const { action, id, password } = req.body;
    const sheets = google.sheets({ version: 'v4', auth });
    
    if (action === 'verifyLogin') {
      // 여기에 구글 시트 로그인 검증 로직이 들어갈 예정입니다.
      res.json({ success: true, message: "Node.js 서버 통신 성공!" });
    } else {
      res.status(400).json({ success: false, message: "알 수 없는 action" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = app;
