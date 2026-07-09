const { google } = require('googleapis');
const crypto = require('crypto');
const stream = require('stream'); // 🌟 Vercel 호환용 업로드 스트림 모듈 추가

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
    
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
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
        if (String(row[i][2]) === String(body.id)) {
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!E${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[hashedNewPassword]] } });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!G${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['N']] } });
          return res.status(200).json({ success: true });
        }
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    // 3. 기사님 배차 조회 (undefined 오류 방지)
    if (action === 'getDriverDispatch') {
      const dateObj = new Date(body.targetDate);
      const month = dateObj.getMonth() + 1;
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${month}월_호차배정!A2:E`, `${month}월_배차리스트!A2:K`],
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
        if (!assignedVehicle) return res.status(200).json({ success: true, data: [], message: '배정된 호차가 없습니다.' });

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
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${month}월_호차배정!A2:E`, `${month}월_배차리스트!A2:K`],
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

    // 5. 🌟 사진 업로드 (500 에러 완벽 해결)
    if (action === 'uploadDashboardPhoto') {
      try {
        const usersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:F' });
        let driverName = ''; let vehicleNum = '';
        for(let row of (usersRes.data.values || [])) { if(String(row[2]) === String(body.driverId)) { driverName = row[1]; vehicleNum = row[5]; break; } }

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
        const newFileName = `${driverName}_${body.stage}_${vehicleNum}_${timeStr}${ext}`;
        
        // 🌟 Vercel 환경에 최적화된 안전한 버퍼 스트림 생성 방식
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
          requestBody: { values: [[ body.customDate, body.driverId, driverName, vehicleNum, body.stage, fileRes.data.webViewLink, fileRes.data.id ]] }
        });
        return res.status(200).json({ success: true, url: fileRes.data.webViewLink });
      } catch (err) {
        // 정확한 구글 API 에러 원인을 반환
        return res.status(200).json({ success: false, message: `구글 연동 오류: ${err.message}` });
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

    // 🌟 8. [관리자] 당일 상세 현황 (요청하신 지표 반영)
    if (action === 'getAdminDailyStatus') {
      const dateObj = new Date(body.targetDate);
      const month = dateObj.getMonth() + 1;
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:F', `${month}월_호차배정!A2:D`, `${month}월_배차리스트!A2:K`],
        });
        const users = response.data.valueRanges[0].values || [];
        const assign = response.data.valueRanges[1].values || [];
        const dispatch = response.data.valueRanges[2].values || [];
        
        const dateString = body.targetDate.substring(0, 10);
        let dailyList = [];
        let activeVehicles = new Set(); // 금일 가동 호차 수 계산용

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
          // 요청사항: clientAddr(배송지 주소)는 제외하고 clientName만 전달
          dailyList.push({
            vehicle: vehicle, driverName: driverName, driverPhone: driverPhone,
            clientName: row[3], arrivalTime: row[10] || ""
          });
        }
        return res.status(200).json({ success: true, data: dailyList, vehicleCount: activeVehicles.size });
      } catch (err) { return res.status(200).json({ success: false, message: '데이터 조회 실패 (해당 월의 배차 탭을 확인하세요)' }); }
    }

    // 🌟 9. [관리자] 월별 통계 분석 (신규 분석 기능)
    if (action === 'getAdminMonthlyStats') {
      const monthStr = body.targetMonth; // ex: "2026-07"
      const monthNum = parseInt(monthStr.split('-')[1], 10);
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: `${monthNum}월_배차리스트!A2:K`,
        });
        const dispatch = response.data.values || [];
        let statsObj = {};

        for (let row of dispatch) {
          if(!row[0]) continue;
          let dateKey = String(row[0]).substring(0, 10);
          if(!dateKey.startsWith(monthStr)) continue; // 해당 월만 필터링
          
          if(!statsObj[dateKey]) {
            statsObj[dateKey] = { date: dateKey, vehicles: new Set(), total: 0, done: 0 };
          }
          statsObj[dateKey].vehicles.add(String(row[1]));
          statsObj[dateKey].total++;
          if(row[10]) statsObj[dateKey].done++;
        }

        // Set을 숫자로 변환하여 배열로 만들기
        let statsArray = Object.keys(statsObj).map(date => ({
          date: date,
          vehicleCount: statsObj[date].vehicles.size,
          totalCount: statsObj[date].total,
          doneCount: statsObj[date].done,
          missingCount: statsObj[date].total - statsObj[date].done
        })).sort((a, b) => a.date.localeCompare(b.date));

        return res.status(200).json({ success: true, data: statsArray });
      } catch (err) { return res.status(200).json({ success: false, message: '해당 월의 데이터가 없습니다.' }); }
    }

    // 10. [관리자] 기사 목록 조회
    if (action === 'getDriverList') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      let drivers = [];
      for (let row of (response.data.values || [])) {
        if (row[0] === 'driver') drivers.push({ name: row[1], id: String(row[2]), phone: row[3], vehicle: row[5], isFirst: row[6] });
      }
      return res.status(200).json({ success: true, data: drivers });
    }

    // 11. [관리자] 신규 기사 등록
    if (action === 'createDriverAccount') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:D' });
      const cleanPhone = body.phone.replace(/-/g, '');
      let loginId = cleanPhone.startsWith('010') ? cleanPhone.substring(3) : cleanPhone;
      for (let row of (response.data.values || [])) {
        if (String(row[3]).replace(/-/g, '') === cleanPhone || String(row[2]) === loginId) return res.status(200).json({ success: false, message: '이미 등록된 기사님입니다.' });
      }
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Users!A:G', valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['driver', body.name, `'${loginId}`, `'${cleanPhone}`, hashPassword('0000'), body.vehicle, 'Y']] }
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 요청입니다.' });
  } catch (error) { return res.status(200).json({ success: false, message: `시스템 에러: ${error.message}` }); }
}
