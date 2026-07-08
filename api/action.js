const { google } = require('googleapis');
const crypto = require('crypto');

// 비밀번호 암호화 함수 (기존 GAS와 100% 동일)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST 요청만 받습니다.' });
  }

  try {
    const { action, id, password, newPassword, driverId, targetDate, orderNum, orderSeq } = req.body;
    
    // 환경 변수에서 구글 마스터키 꺼내기
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8';

    // -----------------------------------------------------------
    // 1. 로그인 기능
    // -----------------------------------------------------------
    if (action === 'verifyLogin') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Users!A2:G', 
      });
      
      const rows = response.data.values || [];
      const hashedPassword = hashPassword(password);
      
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(id) && String(rows[i][4]) === hashedPassword) {
          return res.status(200).json({
            success: true,
            role: rows[i][0],
            name: rows[i][1],
            isFirstLogin: rows[i][6] === 'Y'
          });
        }
      }
      return res.status(200).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }

    // -----------------------------------------------------------
    // 2. 최초 로그인 시 비밀번호 변경 기능
    // -----------------------------------------------------------
    if (action === 'changePassword') {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Users!A2:G',
      });
      const rows = response.data.values || [];
      const hashedNewPassword = hashPassword(newPassword);

      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(id)) {
          // E열(비밀번호) 업데이트
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: `Users!E${i + 2}`,
            valueInputOption: 'USER_ENTERED', requestBody: { values: [[hashedNewPassword]] }
          });
          // G열(최초로그인) 업데이트
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: `Users!G${i + 2}`,
            valueInputOption: 'USER_ENTERED', requestBody: { values: [['N']] }
          });
          return res.status(200).json({ success: true });
        }
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    // -----------------------------------------------------------
    // 3. 배차 스케줄 초고속 불러오기 (batchGet 활용)
    // -----------------------------------------------------------
    if (action === 'getDriverDispatch') {
      const dateObj = new Date(targetDate);
      const month = dateObj.getMonth() + 1;
      const assignSheetName = `${month}월_호차배정`;
      const dispatchSheetName = `${month}월_배차리스트`;

      try {
        // 🌟 Users, 호차배정, 배차리스트 3개의 시트를 한 방에 불러옵니다.
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID,
          ranges: ['Users!A2:G', `${assignSheetName}!A2:E`, `${dispatchSheetName}!A2:K`],
        });

        const usersData = response.data.valueRanges[0].values || [];
        const assignData = response.data.valueRanges[1].values || [];
        const dispatchData = response.data.valueRanges[2].values || [];

        // 내 휴대폰 번호 찾기
        let fullPhone = "";
        for (let i = 0; i < usersData.length; i++) {
          if (String(usersData[i][2]) === String(driverId)) {
            fullPhone = String(usersData[i][3]).replace(/[-']/g, ''); break;
          }
        }
        if (!fullPhone) return res.status(200).json({ success: false, message: '기사 정보를 찾을 수 없습니다.' });

        const dateString = targetDate.substring(0, 10);
        let assignedVehicle = "";

        // 내 호차 번호 찾기
        for (let i = 0; i < assignData.length; i++) {
          if(!assignData[i][0]) continue;
          let aDateStr = String(assignData[i][0]).substring(0, 10);
          let aPhone = String(assignData[i][3]).replace(/[-']/g, '');
          if (aDateStr === dateString && aPhone === fullPhone) {
            assignedVehicle = assignData[i][1]; break;
          }
        }
        if (!assignedVehicle) return res.status(200).json({ success: true, data: [], message: '배정된 호차가 없습니다.' });

        // 내 배차 리스트 조립하기
        let dispatchList = [];
        for (let i = 0; i < dispatchData.length; i++) {
          if(!dispatchData[i][0]) continue;
          let dDateStr = String(dispatchData[i][0]).substring(0, 10);
          let dVehicle = String(dispatchData[i][1]);

          if (dDateStr === dateString && dVehicle === assignedVehicle) {
            let rawTime = dispatchData[i][10] || "";
            let formattedTime = String(rawTime).length >= 5 ? String(rawTime).substring(0, 5) : String(rawTime);

            dispatchList.push({
              order: dispatchData[i][2],       
              clientName: dispatchData[i][3],  
              clientAddr: dispatchData[i][4],  
              clientPhone: dispatchData[i][5], 
              orderNum: dispatchData[i][6],    
              prodName: dispatchData[i][7],    
              qty: dispatchData[i][8],         
              remarks: dispatchData[i][9],      
              arrivalTime: formattedTime
            });
          }
        }
        dispatchList.sort((a, b) => Number(a.order) - Number(b.order));
        return res.status(200).json({ success: true, vehicle: assignedVehicle, data: dispatchList });
      } catch (err) {
        return res.status(200).json({ success: false, message: '해당 월의 배차 탭이 아직 생성되지 않았습니다.' });
      }
    }

    // -----------------------------------------------------------
    // 4. 배송지 도착 시간 기록
    // -----------------------------------------------------------
    if (action === 'recordArrivalTime') {
      const dateObj = new Date(targetDate);
      const month = dateObj.getMonth() + 1;
      const assignSheetName = `${month}월_호차배정`;
      const dispatchSheetName = `${month}월_배차리스트`;

      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID,
          ranges: ['Users!A2:G', `${assignSheetName}!A2:E`, `${dispatchSheetName}!A2:K`],
        });

        const usersData = response.data.valueRanges[0].values || [];
        const assignData = response.data.valueRanges[1].values || [];
        const dispatchData = response.data.valueRanges[2].values || [];

        let fullPhone = "";
        for (let i = 0; i < usersData.length; i++) {
          if (String(usersData[i][2]) === String(driverId)) {
            fullPhone = String(usersData[i][3]).replace(/[-']/g, ''); break;
          }
        }

        const dateString = targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let i = 0; i < assignData.length; i++) {
          if(!assignData[i][0]) continue;
          let aDateStr = String(assignData[i][0]).substring(0, 10);
          let aPhone = String(assignData[i][3]).replace(/[-']/g, '');
          if (aDateStr === dateString && aPhone === fullPhone) {
            assignedVehicle = assignData[i][1]; break;
          }
        }

        for (let i = 0; i < dispatchData.length; i++) {
          if(!dispatchData[i][0]) continue;
          let dDateStr = String(dispatchData[i][0]).substring(0, 10);
          let dVehicle = String(dispatchData[i][1]);
          let dSeq = String(dispatchData[i][2]);
          let dOrderNum = String(dispatchData[i][6]);

          if (dDateStr === dateString && dVehicle === assignedVehicle && dSeq === String(orderSeq) && dOrderNum === String(orderNum)) {
            
            // 🌟 Vercel 서버는 외국에 있으므로, 한국 시간(KST)으로 강제 변환
            const now = new Date();
            const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
            const hours = String(kst.getUTCHours()).padStart(2, '0');
            const minutes = String(kst.getUTCMinutes()).padStart(2, '0');
            const timeStr = `${hours}:${minutes}`;

            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `${dispatchSheetName}!K${i + 2}`, // K열에 시간 기록
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[timeStr]] }
            });

            return res.status(200).json({ success: true, arrivalTime: timeStr });
          }
        }
        return res.status(200).json({ success: false, message: '일치하는 배차 정보를 찾을 수 없습니다.' });
      } catch (err) {
        return res.status(200).json({ success: false, message: '도착 시간 기록 중 오류가 발생했습니다.' });
      }
    }

    return res.status(400).json({ success: false, message: '알 수 없는 action 입니다.' });
  } catch (error) {
    console.error("서버 에러:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
