const { google } = require('googleapis');
const crypto = require('crypto');
const stream = require('stream'); 

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청만 받습니다.' });

  try {
    const body = req.body;
    const action = body.action;
    
    // 🌟 핵심 에러 해결 구간: Vercel 줄바꿈 제어문자(Bad control character) 완벽 차단
    let credentials;
    try {
      let rawCreds = process.env.GOOGLE_CREDENTIALS || '{}';
      // 1. 실제 엔터(\n)를 문자열 '\\n'으로 치환하여 JSON 파싱이 안 깨지게 만듦
      rawCreds = rawCreds.replace(/\n/g, '\\n').replace(/\r/g, ''); 
      
      // 2. 안전하게 객체로 파싱
      credentials = JSON.parse(rawCreds); 
      
      // 3. 구글 인증 라이브러리가 인식할 수 있도록 private_key 부분만 다시 실제 줄바꿈으로 복구
      if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
      }
    } catch (parseErr) {
      return res.status(200).json({ success: false, message: '구글 인증키 설정 오류: 환경변수를 다시 확인해주세요.' });
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8';
    const FOLDER_ID = '12y-08UOW1srIpmFjlfaeLdbVv9ujWZRR';

    // 1. 로그인
    if (action === 'verifyLogin') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      const rows = response.data.values || [];
      const hashedPassword = hashPassword(body.password);
      for (let row of rows) {
        if (String(row[2]) === String(body.id) && String(row[4]) === hashedPassword) {
          return res.status(200).json({ success: true, role: row[0], name: row[1], isFirstLogin: row[6] === 'Y' });
        }
      }
      return res.status(200).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }

    // 2. 비밀번호 변경
    if (action === 'changePassword') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      const rows = response.data.values || [];
      const hashedNewPassword = hashPassword(body.newPassword);
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(body.id)) {
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!E${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[hashedNewPassword]] } });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!G${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['N']] } });
          return res.status(200).json({ success: true });
        }
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    // 3. 기사님 배차 조회
    if (action === 'getDriverDispatch') {
      const dateObj = new Date(body.targetDate);
      const month = dateObj.getMonth() + 1;
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${month}월_호차배정!A2:D`, `${month}월_배차리스트!A2:K`],
        });
        const usersData = response.data.valueRanges[0].values || [];
        const assignData = response.data.valueRanges[1].values || [];
        const dispatchData = response.data.valueRanges[2].values || [];

        let fullPhone = "";
        for (let row of usersData) { if (String(row[2]) === String(body.driverId)) { fullPhone = String(row[3]).replace(/[-']/g, ''); break; } }
        if (!fullPhone) return res.status(200).json({ success: false, message: '기사 정보를 찾을 수 없습니다.' });

        const dateString = body.targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let row of assignData) {
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[3]).replace(/[-']/g, '') === fullPhone) { assignedVehicle = row[1]; break; }
        }
        if (!assignedVehicle) return res.status(200).json({ success: true, data: [], message: '금일 배정된 호차가 없습니다.' });

        let dispatchList = [];
        for (let row of dispatchData) {
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[1]) === assignedVehicle) {
            let rawTime = row[10] || "";
            dispatchList.push({
              order: row[2], clientName: row[3], clientAddr: row[4], clientPhone: row[5], orderNum: row[6], prodName: row[7], qty: row[8], remarks: row[9], 
              arrivalTime: String(rawTime).length >= 5 ? String(rawTime).substring(0, 5) : String(rawTime)
            });
          }
        }
        dispatchList.sort((a, b) => Number(a.order) - Number(b.order));
        return res.status(200).json({ success: true, vehicle: assignedVehicle, data: dispatchList });
      } catch (err) { 
        return res.status(200).json({ success: false, message: `${month}월 배차 탭이 시트에 존재하지 않습니다.` }); 
      }
    }

    // 4. 도착 시간 기록
    if (action === 'recordArrivalTime') {
      const dateObj = new Date(body.targetDate);
      const month = dateObj.getMonth() + 1;
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${month}월_호차배정!A2:D`, `${month}월_배차리스트!A2:K`],
        });
        const usersData = response.data.valueRanges[0].values || [];
        const assignData = response.data.valueRanges[1].values || [];
        const dispatchData = response.data.valueRanges[2].values || [];

        let fullPhone = "";
        for (let row of usersData) { if (String(row[2]) === String(body.driverId)) { fullPhone = String(row[3]).replace(/[-']/g, ''); break; } }
        const dateString = body.targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let row of assignData) {
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[3]).replace(/[-']/g, '') === fullPhone) { assignedVehicle = row[1]; break; }
        }

        for (let i = 0; i < dispatchData.length; i++) {
          let row = dispatchData[i];
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[1]) === assignedVehicle && String(row[2]) === String(body.orderSeq) && String(row[6]) === String(body.orderNum)) {
            const kst = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
            const timeStr = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID, range: `${month}월_배차리스트!K${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[timeStr]] }
            });
            return res.status(200).json({ success: true, arrivalTime: timeStr });
          }
        }
        return res.status(200).json({ success: false, message: '일치하는 배차 정보를 찾을 수 없습니다.' });
      } catch (err) { return res.status(200).json({ success: false, message: '도착 기록 중 오류 발생' }); }
    }

    // 5. 사진 업로드 (잘 작동하던 원본 PassThrough 방식으로 복구 완료)
    if (action === 'uploadDashboardPhoto') {
      try {
        const usersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
        let driverName = ''; let carNum = '';
        for(let row of (usersRes.data.values || [])) { 
          if(String(row[2]) === String(body.driverId)) { 
            driverName = row[1]; carNum = row[5]; break; 
          } 
        }

        const tDate = new Date(body.customDate);
        const kst = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
        const yearMonthStr = `${tDate.getFullYear()}년 ${String(tDate.getMonth()+1).padStart(2,'0')}월`;
        const dayStr = `${String(tDate.getDate()).padStart(2,'0')}일`;
        const timeStr = `${String(kst.getUTCHours()).padStart(2,'0')}${String(kst.getUTCMinutes()).padStart(2,'0')}${String(kst.getUTCSeconds()).padStart(2,'0')}`;

        async function getOrCreateFolder(name, parentId) {
          const query = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
          const res = await drive.files.list({ q: query, fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true });
          if (res.data.files.length > 0) return res.data.files[0].id;
          const createRes = await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id', supportsAllDrives: true });
          return createRes.data.id;
        }

        const monthFolderId = await getOrCreateFolder(yearMonthStr, FOLDER_ID);
        const dayFolderId = await getOrCreateFolder(dayStr, monthFolderId);

        const ext = body.fileName.substring(body.fileName.lastIndexOf('.'));
        const newFileName = `${driverName}_${body.stage}_${carNum}_${timeStr}${ext}`;
        
        const mimeType = body.base64Data.substring(5, body.base64Data.indexOf(';'));
        const buffer = Buffer.from(body.base64Data.split(',')[1], 'base64');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);

        const fileRes = await drive.files.create({
          requestBody: { name: newFileName, parents: [dayFolderId] }, media: { mimeType: mimeType, body: bufferStream }, fields: 'id, webViewLink', supportsAllDrives: true
        });
        await drive.permissions.create({ fileId: fileRes.data.id, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true });
        
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: 'Photos!A:G', valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ body.customDate, body.driverId, driverName, carNum, body.stage, fileRes.data.webViewLink, fileRes.data.id ]] }
        });
        return res.status(200).json({ success: true, url: fileRes.data.webViewLink });
      } catch (err) {
        return res.status(200).json({ success: false, message: `구글 드라이브 연동 오류: ${err.message}` });
      }
    }

    // 6. 사진 조회 / 7. 삭제
    if (action === 'getDriverPhotos') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A2:G' });
      const photos = [];
      for(let row of (response.data.values || [])) {
        if(row[1] && String(row[1]) === String(body.driverId)) photos.push({ dateKey: String(row[0]).substring(0, 10), stage: row[4] || "", url: row[5] || "", fileId: row[6] || "" });
      }
      return res.status(200).json({ success: true, data: photos });
    }
    if (action === 'deleteDriverPhoto') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A1:G' });
      const data = response.data.values || [];
      let rowIndex = -1;
      for (let i = 0; i < data.length; i++) { if (data[i][6] && String(data[i][6]) === String(body.fileId) && String(data[i][1]) === String(body.driverId)) { rowIndex = i; break; } }
      if (rowIndex !== -1) {
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetId = sheetMeta.data.sheets.find(s => s.properties.title === 'Photos').properties.sheetId;
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] } });
      }
      try { await drive.files.update({ fileId: body.fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e) {}
      return res.status(200).json({ success: true });
    }

    // 8. 당일 상세 현황
    if (action === 'getAdminDailyStatus') {
      const dateObj = new Date(body.targetDate);
      const month = dateObj.getMonth() + 1;
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${month}월_호차배정!A2:D`, `${month}월_배차리스트!A2:K`],
        });
        const users = response.data.valueRanges[0].values || [];
        const assign = response.data.valueRanges[1].values || [];
        const dispatch = response.data.valueRanges[2].values || [];
        
        const dateString = body.targetDate.substring(0, 10);
        let dailyList = [];
        let activeVehicles = new Set();

        for (let row of dispatch) {
          if(!row[0] || String(row[0]).substring(0, 10) !== dateString) continue;
          let vehicle = String(row[1]);
          activeVehicles.add(vehicle);

          let driverName = "미배정", driverPhone = "";
          for (let a of assign) {
            if(String(a[0]).substring(0, 10) === dateString && String(a[1]) === vehicle) {
              let aPhone = String(a[3]).replace(/[-']/g, '');
              for (let u of users) { if(String(u[3]).replace(/[-']/g, '') === aPhone) { driverName = u[1]; driverPhone = u[3]; break; } }
              break;
            }
          }
          dailyList.push({
            vehicle: vehicle, driverName: driverName, driverPhone: driverPhone,
            clientName: row[3], arrivalTime: row[10] || ""
          });
        }
        return res.status(200).json({ success: true, data: dailyList, vehicleCount: activeVehicles.size });
      } catch (err) { return res.status(200).json({ success: false, message: '데이터 조회 실패 (해당 월의 배차 탭을 확인하세요)' }); }
    }

    // 9. 월별 통계 분석
    if (action === 'getAdminMonthlyStats') {
      const monthStr = body.targetMonth;
      const monthNum = parseInt(monthStr.split('-')[1], 10);
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: `${monthNum}월_배차리스트!A2:K`,
        });
        const dispatch = response.data.values || [];
        
        let statsObj = {};
        let hospitalStats = {};
        let vehicleStats = {};

        const timeToMins = (timeStr) => {
          if(!timeStr || !timeStr.includes(':')) return 0;
          const [h, m] = timeStr.split(':');
          return parseInt(h)*60 + parseInt(m);
        };

        for (let row of dispatch) {
          if(!row[0]) continue;
          let dateKey = String(row[0]).substring(0, 10);
          if(!dateKey.startsWith(monthStr)) continue;
          
          let vehicle = String(row[1] || '미정');
          let client = String(row[3] || '알수없음');
          let arrTime = row[10] || null;

          if(!statsObj[dateKey]) statsObj[dateKey] = { date: dateKey, vehicles: new Set(), total: 0, done: 0 };
          statsObj[dateKey].vehicles.add(vehicle);
          statsObj[dateKey].total++;
          if(arrTime) statsObj[dateKey].done++;

          if(!hospitalStats[client]) hospitalStats[client] = { count: 0, arrTimes: [] };
          hospitalStats[client].count++;
          if(arrTime) hospitalStats[client].arrTimes.push(timeToMins(arrTime));

          if(!vehicleStats[vehicle]) vehicleStats[vehicle] = { count: 0, clients: new Set(), endTimes: [] };
          vehicleStats[vehicle].count++;
          vehicleStats[vehicle].clients.add(client);
          if(arrTime) vehicleStats[vehicle].endTimes.push({ date: dateKey, time: timeToMins(arrTime) });
        }

        let statsArray = Object.keys(statsObj).map(date => ({
          date: date, vehicleCount: statsObj[date].vehicles.size, totalCount: statsObj[date].total,
          doneCount: statsObj[date].done, missingCount: statsObj[date].total - statsObj[date].done
        })).sort((a, b) => a.date.localeCompare(b.date));

        let vStatsOut = [];
        for(let v in vehicleStats) {
           let endTimesByDate = {};
           vehicleStats[v].endTimes.forEach(et => {
             if(!endTimesByDate[et.date] || endTimesByDate[et.date] < et.time) endTimesByDate[et.date] = et.time;
           });
           let totalMins = 0; let dayCount = 0;
           for(let d in endTimesByDate) { totalMins += endTimesByDate[d]; dayCount++; }
           let avgStr = "-";
           if(dayCount > 0) {
             let avgMin = Math.floor(totalMins / dayCount);
             avgStr = `${String(Math.floor(avgMin/60)).padStart(2,'0')}:${String(avgMin%60).padStart(2,'0')}`;
           }
           vStatsOut.push({ vehicle: v, clientCount: vehicleStats[v].clients.size, totalDeliveries: vehicleStats[v].count, avgEndTime: avgStr });
        }

        let hStatsOut = Object.keys(hospitalStats).map(h => {
           let totalMins = hospitalStats[h].arrTimes.reduce((acc, val) => acc + val, 0);
           let arrCount = hospitalStats[h].arrTimes.length;
           let avgStr = "-";
           if(arrCount > 0) {
             let avgMin = Math.floor(totalMins / arrCount);
             avgStr = `${String(Math.floor(avgMin/60)).padStart(2,'0')}:${String(avgMin%60).padStart(2,'0')}`;
           }
           return { hospital: h, count: hospitalStats[h].count, avgTime: avgStr };
        }).sort((a,b) => b.count - a.count);

        return res.status(200).json({ 
          success: true, 
          data: statsArray,
          hospitalData: hStatsOut,
          vehicleData: vStatsOut
        });
      } catch (err) { return res.status(200).json({ success: false, message: '해당 월의 데이터가 없습니다.' }); }
    }

    // 10. 기사 목록 조회
    if (action === 'getDriverList') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      let drivers = [];
      for (let row of (response.data.values || [])) {
        if (row[0] === 'driver') drivers.push({ name: row[1], id: String(row[2]), phone: row[3], carNumber: row[5] || '미등록' });
      }
      return res.status(200).json({ success: true, data: drivers });
    }

    // 11. 신규 기사 등록
    if (action === 'createDriverAccount') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:G' });
      const cleanPhone = body.phone.replace(/-/g, '');
      const formatPhone = cleanPhone.replace(/^(\d{2,3})(\d{3,4})(\d{4})$/, `$1-$2-$3`);
      let loginId = cleanPhone.startsWith('010') ? cleanPhone.substring(3) : cleanPhone;
      
      for (let row of (response.data.values || [])) {
        if (String(row[3]).replace(/-/g, '') === cleanPhone || String(row[2]) === loginId) return res.status(200).json({ success: false, message: '이미 등록된 기사님 혹은 번호입니다.' });
      }
      
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Users!A:G', valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['driver', body.name, `'${loginId}`, `'${formatPhone}`, hashPassword('0000'), body.carNumber, 'Y']] }
      });
      return res.status(200).json({ success: true });
    }

    // 12. 기사 비밀번호 초기화
    if (action === 'resetDriverPassword') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A1:G' });
      const rows = response.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(body.id)) {
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!E${i + 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[hashPassword('0000')]] } });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!G${i + 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['Y']] } });
          return res.status(200).json({ success: true });
        }
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    // 13. 기사 계정 삭제
    if (action === 'deleteDriverAccount') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A1:G' });
      const rows = response.data.values || [];
      let rowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(body.id)) { rowIndex = i; break; }
      }
      if (rowIndex !== -1) {
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetId = sheetMeta.data.sheets.find(s => s.properties.title === 'Users').properties.sheetId;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] }
        });
        return res.status(200).json({ success: true });
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 요청입니다.' });
  } catch (error) { return res.status(200).json({ success: false, message: `시스템 에러: ${error.message}` }); }
}
