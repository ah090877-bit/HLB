const { google } = require('googleapis');
const crypto = require('crypto');
const { Readable } = require('stream'); // 🌟 이미지 업로드를 위해 추가된 모듈

// 비밀번호 암호화 함수
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST 요청만 받습니다.' });
  }

  try {
    // 프론트에서 넘어오는 모든 변수 받기
    const { action, id, password, newPassword, driverId, targetDate, orderNum, orderSeq, base64Data, fileName, stage, customDate, fileId } = req.body;
    
    // 환경 변수에서 구글 마스터키 꺼내기
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8';
    const FOLDER_ID = '12y-08UOW1srIpmFjlfaeLdbVv9ujWZRR'; // 메인 구글 드라이브 폴더 ID

    // -----------------------------------------------------------
    // 1. 로그인
    // -----------------------------------------------------------
    if (action === 'verifyLogin') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      const rows = response.data.values || [];
      const hashedPassword = hashPassword(password);
      
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(id) && String(rows[i][4]) === hashedPassword) {
          return res.status(200).json({ success: true, role: rows[i][0], name: rows[i][1], isFirstLogin: rows[i][6] === 'Y' });
        }
      }
      return res.status(200).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }

    // -----------------------------------------------------------
    // 2. 비밀번호 변경
    // -----------------------------------------------------------
    if (action === 'changePassword') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      const rows = response.data.values || [];
      const hashedNewPassword = hashPassword(newPassword);

      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][2]) === String(id)) {
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!E${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[hashedNewPassword]] } });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Users!G${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['N']] } });
          return res.status(200).json({ success: true });
        }
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    // -----------------------------------------------------------
    // 3. 배차 스케줄 조회
    // -----------------------------------------------------------
    if (action === 'getDriverDispatch') {
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
          if (String(usersData[i][2]) === String(driverId)) { fullPhone = String(usersData[i][3]).replace(/[-']/g, ''); break; }
        }
        if (!fullPhone) return res.status(200).json({ success: false, message: '기사 정보를 찾을 수 없습니다.' });

        const dateString = targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let i = 0; i < assignData.length; i++) {
          if(!assignData[i][0]) continue;
          let aDateStr = String(assignData[i][0]).substring(0, 10);
          let aPhone = String(assignData[i][3]).replace(/[-']/g, '');
          if (aDateStr === dateString && aPhone === fullPhone) { assignedVehicle = assignData[i][1]; break; }
        }
        if (!assignedVehicle) return res.status(200).json({ success: true, data: [], message: '배정된 호차가 없습니다.' });

        let dispatchList = [];
        for (let i = 0; i < dispatchData.length; i++) {
          if(!dispatchData[i][0]) continue;
          let dDateStr = String(dispatchData[i][0]).substring(0, 10);
          let dVehicle = String(dispatchData[i][1]);

          if (dDateStr === dateString && dVehicle === assignedVehicle) {
            let rawTime = dispatchData[i][10] || "";
            let formattedTime = String(rawTime).length >= 5 ? String(rawTime).substring(0, 5) : String(rawTime);
            dispatchList.push({
              order: dispatchData[i][2], clientName: dispatchData[i][3], clientAddr: dispatchData[i][4], clientPhone: dispatchData[i][5], 
              orderNum: dispatchData[i][6], prodName: dispatchData[i][7], qty: dispatchData[i][8], remarks: dispatchData[i][9], arrivalTime: formattedTime
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
    // 4. 배송지 도착 기록
    // -----------------------------------------------------------
    if (action === 'recordArrivalTime') {
      const dateObj = new Date(targetDate);
      const month = dateObj.getMonth() + 1;
      const assignSheetName = `${month}월_호차배정`;
      const dispatchSheetName = `${month}월_배차리스트`;

      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${assignSheetName}!A2:E`, `${dispatchSheetName}!A2:K`],
        });
        const usersData = response.data.valueRanges[0].values || [];
        const assignData = response.data.valueRanges[1].values || [];
        const dispatchData = response.data.valueRanges[2].values || [];

        let fullPhone = "";
        for (let i = 0; i < usersData.length; i++) {
          if (String(usersData[i][2]) === String(driverId)) { fullPhone = String(usersData[i][3]).replace(/[-']/g, ''); break; }
        }

        const dateString = targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let i = 0; i < assignData.length; i++) {
          if(!assignData[i][0]) continue;
          let aDateStr = String(assignData[i][0]).substring(0, 10);
          let aPhone = String(assignData[i][3]).replace(/[-']/g, '');
          if (aDateStr === dateString && aPhone === fullPhone) { assignedVehicle = assignData[i][1]; break; }
        }

        for (let i = 0; i < dispatchData.length; i++) {
          if(!dispatchData[i][0]) continue;
          let dDateStr = String(dispatchData[i][0]).substring(0, 10);
          let dVehicle = String(dispatchData[i][1]);
          let dSeq = String(dispatchData[i][2]);
          let dOrderNum = String(dispatchData[i][6]);

          if (dDateStr === dateString && dVehicle === assignedVehicle && dSeq === String(orderSeq) && dOrderNum === String(orderNum)) {
            const now = new Date();
            const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
            const hours = String(kst.getUTCHours()).padStart(2, '0');
            const minutes = String(kst.getUTCMinutes()).padStart(2, '0');
            const timeStr = `${hours}:${minutes}`;

            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID, range: `${dispatchSheetName}!K${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[timeStr]] }
            });
            return res.status(200).json({ success: true, arrivalTime: timeStr });
          }
        }
        return res.status(200).json({ success: false, message: '일치하는 배차 정보를 찾을 수 없습니다.' });
      } catch (err) {
        return res.status(200).json({ success: false, message: '도착 시간 기록 중 오류가 발생했습니다.' });
      }
    }

    // -----------------------------------------------------------
    // 5. 🌟 사진 업로드 (신규)
    // -----------------------------------------------------------
    if (action === 'uploadDashboardPhoto') {
      const usersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:F' });
      const usersData = usersRes.data.values || [];
      let driverName = ''; let vehicleNum = '';
      
      for(let row of usersData) {
        if(String(row[2]) === String(driverId)) { driverName = row[1]; vehicleNum = row[5]; break; }
      }

      const tDate = new Date(customDate);
      const now = new Date();
      const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
      const yearMonthStr = `${tDate.getFullYear()}년 ${String(tDate.getMonth()+1).padStart(2,'0')}월`;
      const dayStr = `${String(tDate.getDate()).padStart(2,'0')}일`;
      const timeStr = `${String(kst.getUTCHours()).padStart(2,'0')}${String(kst.getUTCMinutes()).padStart(2,'0')}${String(kst.getUTCSeconds()).padStart(2,'0')}`;

      // 드라이브 폴더 자동 생성/검색 도우미 함수
      async function getOrCreateFolder(name, parentId) {
        const query = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const res = await drive.files.list({ q: query, fields: 'files(id, name)' });
        if (res.data.files.length > 0) return res.data.files[0].id;
        const createRes = await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id' });
        return createRes.data.id;
      }

      const monthFolderId = await getOrCreateFolder(yearMonthStr, FOLDER_ID);
      const dayFolderId = await getOrCreateFolder(dayStr, monthFolderId);

      const ext = fileName.substring(fileName.lastIndexOf('.'));
      const newFileName = `${driverName}_${stage}_${vehicleNum}_${timeStr}${ext}`;
      
      // Base64 데이터를 스트림으로 변환 (Vercel에서 파일 올리는 방식)
      const mimeType = base64Data.substring(5, base64Data.indexOf(';'));
      const base64Str = base64Data.split(',')[1];
      const buffer = Buffer.from(base64Str, 'base64');
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      const fileRes = await drive.files.create({
        requestBody: { name: newFileName, parents: [dayFolderId] },
        media: { mimeType: mimeType, body: stream },
        fields: 'id, webViewLink'
      });

      const uploadedFileId = fileRes.data.id;
      const fileUrl = fileRes.data.webViewLink;

      // 링크가 있는 모든 사용자 보기 허용
      await drive.permissions.create({ fileId: uploadedFileId, requestBody: { role: 'reader', type: 'anyone' } });

      // Photos 탭에 기록 추가
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Photos!A:G', valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[ customDate, driverId, driverName, vehicleNum, stage, fileUrl, uploadedFileId ]] }
      });

      return res.status(200).json({ success: true, url: fileUrl });
    }

    // -----------------------------------------------------------
    // 6. 🌟 내 사진 목록 조회 (신규)
    // -----------------------------------------------------------
    if (action === 'getDriverPhotos') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A2:G' });
      const data = response.data.values || [];
      const photos = [];
      
      for(let row of data) {
        if(row[1] && String(row[1]) === String(driverId)) {
          let dateKey = String(row[0]).substring(0, 10);
          photos.push({ dateKey: dateKey, stage: row[4] || "", url: row[5] || "", fileId: row[6] || "" });
        }
      }
      return res.status(200).json({ success: true, data: photos });
    }

    // -----------------------------------------------------------
    // 7. 🌟 사진 삭제 (신규)
    // -----------------------------------------------------------
    if (action === 'deleteDriverPhoto') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A1:G' });
      const data = response.data.values || [];
      let rowIndex = -1;
      
      for (let i = 0; i < data.length; i++) {
        if (data[i][6] && String(data[i][6]) === String(fileId) && String(data[i][1]) === String(driverId)) {
          rowIndex = i; break;
        }
      }

      if (rowIndex !== -1) {
        // 시트의 정확한 고유 ID(sheetId)를 찾아 행 삭제
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const photosSheet = sheetMeta.data.sheets.find(s => s.properties.title === 'Photos');
        const sheetId = photosSheet.properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] }
        });
      }

      // 구글 드라이브 파일 휴지통으로 보내기
      try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true } }); } catch(e) { /* 파일이 이미 없어도 무시 */ }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 action 입니다.' });
  } catch (error) {
    console.error("서버 에러:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
