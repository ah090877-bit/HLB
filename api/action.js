const { google } = require('googleapis');

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

    if (action === 'verifyLogin') {
      // 일단 서버가 살아서 대답하는지 확인하는 기초 코드입니다.
      return res.status(200).json({ 
        success: true, 
        role: 'driver', 
        name: '테스트기사', 
        isFirstLogin: false 
      });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 action' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
