const { google } = require('googleapis');
const crypto = require('crypto'); // 비밀번호 암호화를 위한 내장 모듈

// 기존 GAS의 SHA-256과 완벽히 동일한 암호화 함수
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST 요청만 받습니다.' });
  }

  try {
    const { action, id, password } = req.body;
    
    // 환경 변수에서 구글 마스터키 꺼내기
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8'; // 원본 시트 고유 ID

    // 🌟 1. 실제 구글 시트 연동 로그인 로직
    if (action === 'verifyLogin') {
      // Users 탭의 데이터를 통째로 읽어옵니다. (앱스 스크립트보다 훨씬 빠릅니다)
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Users!A2:G', 
      });
      
      const rows = response.data.values || [];
      const hashedPassword = hashPassword(password);
      
      // 시트 데이터 한 줄씩 검사
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        // row[0]=권한, row[1]=이름, row[2]=아이디, row[4]=비밀번호, row[6]=최초로그인
        if (row[2] === id && row[4] === hashedPassword) {
          return res.status(200).json({
            success: true,
            role: row[0],
            name: row[1],
            isFirstLogin: row[6] === 'Y'
          });
        }
      }
      
      // 명단에 없거나 비밀번호가 틀렸을 때
      return res.status(200).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 action' });
  } catch (error) {
    console.error("서버 에러:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
