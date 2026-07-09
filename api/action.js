const { google } = require('googleapis');
const crypto = require('crypto');

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function formatYYMM(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    const parts = dateStr.split('-');
    if (parts.length >= 2) return `${parts[0].slice(-2)}.${parts[1].padStart(2, '0')}`;
    return dateStr;
  }
  return `${String(d.getFullYear()).slice(-2)}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청만 받습니다.' });

  try {
    const body = req.body;
    const action = body.action;
    
    let credentials;
    try {
      let rawCreds = process.env.GOOGLE_CREDENTIALS || '{}';
      rawCreds = rawCreds.replace(/\n/g, '\\n').replace(/\r/g, ''); 
      credentials = JSON.parse(rawCreds); 
      if (credentials.private_key) { credentials.private_key = credentials.private_key.replace(/\\n/g, '\n'); }
    } catch (parseErr) { return res.status(200).json({ success: false, message: '인증키 설정 오류' }); }

    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8';
    const FOLDER_ID = '12y-08UOW1srIpmFjlfaeLdbVv9ujWZRR';
    
    // 🌟 1단계에서 복사한 새로운 웹앱 URL을 여기에 붙여넣어 주세요! (필수)
    const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwe4dJp1-Eow6tC4qB_xWqPof-eF7k1R45uQfO9u-iNlZ7lJ-yUfL_E09l-mP6rIawG/exec";

    // 1. 로그인
    if (action === 'verifyLogin') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      const hashedPassword = hashPassword(body.password);
      for (let row of (response.data.values || [])) {
        if (String(row[2]) === String(body.id) && String(row[4]) === hashedPassword) {
          return res.status(200).json({ success: true, role: row[0], name: row[1], isFirstLogin: row[6] === 'Y' });
        }
      }
      return res.status(200).json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
    }

    // 2. 비밀번호 변경 (초기 로그인)
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

    // 3. 기사 배차 조회 (동일 병원 품목 합치기 적용)
    if (action === 'getDriverDispatch') {
      const prefix = formatYYMM(body.targetDate);
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${prefix}_호차배정!A2:D`, `${prefix}_배차리스트!A2:K`],
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
        if (!assignedVehicle) return res.status(200).json({ success: true, data: [], message: '금일 배정된 호차가 없습니다.' });

        let grouped = {};
        for (let row of dispatchData) {
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[1]) === assignedVehicle) {
            let clientName = String(row[3]);
            let prodStr = `${row[7]}(${row[8]}개)`;
            if (!grouped[clientName]) {
              grouped[clientName] = {
                orderSeq: row[2], clientName: clientName, clientAddr: row[4], clientPhone: row[5], orderNum: row[6],
                prodName: prodStr, qty: Number(row[8]), remarks: row[9] || '', arrivalTime: row[10] ? String(row[10]).substring(0,5) : ""
              };
            } else {
              grouped[clientName].orderSeq += `, ${row[2]}`;
              grouped[clientName].prodName += `, ${prodStr}`;
              grouped[clientName].qty += Number(row[8]);
              if (row[10]) grouped[clientName].arrivalTime = String(row[10]).substring(0,5);
            }
          }
        }
        return res.status(200).json({ success: true, vehicle: assignedVehicle, data: Object.values(grouped) });
      } catch (err) { return res.status(200).json({ success: false, message: `${prefix}_배차리스트 데이터가 없습니다.` }); }
    }

    // 4. 도착 시간 기록
    if (action === 'recordArrivalTime') {
      const prefix = formatYYMM(body.targetDate);
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${prefix}_호차배정!A2:D`, `${prefix}_배차리스트!A2:K`],
        });
        let fullPhone = "";
        for (let row of (response.data.valueRanges[0].values || [])) { if (String(row[2]) === String(body.driverId)) { fullPhone = String(row[3]).replace(/[-']/g, ''); break; } }
        const dateString = body.targetDate.substring(0, 10);
        let assignedVehicle = "";
        for (let row of (response.data.valueRanges[1].values || [])) {
          if (String(row[0]).substring(0, 10) === dateString && String(row[3]).replace(/[-']/g, '') === fullPhone) { assignedVehicle = row[1]; break; }
        }

        const dispatchData = response.data.valueRanges[2].values || [];
        const seqArray = String(body.orderSeq).split(',').map(s => s.trim()); // 묶인 순번 분리
        const kst = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
        const timeStr = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;

        for (let i = 0; i < dispatchData.length; i++) {
          let row = dispatchData[i];
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[1]) === assignedVehicle && seqArray.includes(String(row[2]))) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID, range: `${prefix}_배차리스트!K${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[timeStr]] }
            });
          }
        }
        return res.status(200).json({ success: true, arrivalTime: timeStr });
      } catch (err) { return res.status(200).json({ success: false, message: '기록 중 오류 발생' }); }
    }

    // 5. 사진 업로드 (연월일 폴더 + 파일명 규칙 + 중복방지 + 키로수)
    if (action === 'uploadDashboardPhoto') {
      try {
        const dateString = body.customDate.substring(0, 10);
        const stageClean = body.stage.replace(/\s/g, '');
        
        // 🌟 중복 기입 방지 로직
        const pRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A:G' });
        for(let r of (pRes.data.values || [])) {
          if(r[0] && String(r[0]).substring(0,10) === dateString && String(r[1]) === String(body.driverId) && String(r[4]).replace(/\s/g,'') === stageClean) {
            return res.status(200).json({ success: false, message: '이미 해당 단계의 사진이 등록되어 있습니다.\n기존 내역을 삭제 후 다시 시도해주세요.' });
          }
        }

        const usersRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
        let driverName = '', carNum = '', originPhone = '';
        for(let row of (usersRes.data.values || [])) { 
          if(String(row[2]) === String(body.driverId)) { driverName = row[1]; carNum = row[5]; originPhone = row[3]; break; } 
        }

        const tDate = new Date(body.customDate);
        const kst = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
        
        const yearStr = `${tDate.getFullYear()}년`;
        const monthStr = `${String(tDate.getMonth()+1).padStart(2,'0')}월`;
        const dayStr = `${String(tDate.getDate()).padStart(2,'0')}일`;
        const YYMMDD = String(tDate.getFullYear()).slice(-2) + String(tDate.getMonth()+1).padStart(2,'0') + String(tDate.getDate()).padStart(2,'0');
        const timeStr = `${String(kst.getUTCHours()).padStart(2,'0')}${String(kst.getUTCMinutes()).padStart(2,'0')}${String(kst.getUTCSeconds()).padStart(2,'0')}`;

        const ext = body.fileName.substring(body.fileName.lastIndexOf('.'));
        const newFileName = `${driverName}_${body.stage}_${carNum}_${YYMMDD}_${timeStr}${ext}`;

        const gasResponse = await fetch(GAS_WEB_APP_URL, {
          method: 'POST', body: JSON.stringify({ folderId: FOLDER_ID, fileName: newFileName, base64Data: body.base64Data, yearStr, monthStr, dayStr })
        });
        const gasResult = await gasResponse.json();
        if (!gasResult.success) throw new Error("GAS 업로드 실패");

        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: 'Photos!A:H', valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ body.customDate, body.driverId, driverName, carNum, body.stage, gasResult.url, gasResult.id, body.mileage || '0' ]] }
        });

        // 🌟 운행거리 시트 누적 로직
        if (body.mileage) {
          const prefix = formatYYMM(body.customDate);
          const cleanPhone = originPhone.replace(/[-']/g, '');
          try {
            const mRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A2:H` });
            const mRows = mRes.data.values || [];
            let targetRowIndex = -1;
            for (let i = 0; i < mRows.length; i++) {
              if (String(mRows[i][0]).substring(0,10) === dateString && String(mRows[i][2]).replace(/[-']/g, '') === cleanPhone) { targetRowIndex = i + 2; break; }
            }

            let colLetter = '';
            if (stageClean.includes('자택출발')) colLetter = 'D';
            else if (stageClean.includes('센터입차')) colLetter = 'E';
            else if (stageClean.includes('센터복귀')) colLetter = 'F';
            else if (stageClean.includes('자택도착')) colLetter = 'G';

            if (targetRowIndex !== -1 && colLetter) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!${colLetter}${targetRowIndex}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[body.mileage]] }
              });
              if (stageClean.includes('자택도착')) {
                const uRowRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A${targetRowIndex}:G${targetRowIndex}` });
                const startKm = parseInt((uRowRes.data.values[0] || [])[3]) || 0;
                const endKm = parseInt(body.mileage) || 0;
                if (startKm > 0 && endKm >= startKm) {
                  await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!H${targetRowIndex}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[endKm - startKm]] }
                  });
                }
              }
            } else if (targetRowIndex === -1) {
              const newRow = [dateString, driverName, originPhone, '', '', '', '', '0'];
              if(colLetter==='D') newRow[3] = body.mileage; else if(colLetter==='E') newRow[4] = body.mileage; else if(colLetter==='F') newRow[5] = body.mileage; else if(colLetter==='G') newRow[6] = body.mileage;
              await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A:H`, valueInputOption: 'USER_ENTERED', requestBody: { values: [newRow] } });
            }
          } catch(se) {}
        }
        return res.status(200).json({ success: true, url: gasResult.url });
      } catch (err) { return res.status(200).json({ success: false, message: `구글 연동 오류: ${err.message}` }); }
    }

    // 6. 사진 조회 (과거 텍스트 날짜 파싱)
    if (action === 'getDriverPhotos') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A2:H' });
      const photos = [];
      for(let row of (response.data.values || [])) {
        if(row[1] && String(row[1]) === String(body.driverId)) {
          let rawDate = String(row[0] || "");
          let cleanDate = rawDate.substring(0, 10);
          let match = rawDate.match(/^(\d{4})[./년\s]+(\d{1,2})[./월\s]+(\d{1,2})/);
          if (match) { cleanDate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`; }
          photos.push({ dateKey: cleanDate, stage: String(row[4]||"").replace(/\s/g, ''), url: row[5] || "", fileId: row[6] || "", mileage: row[7] || '0' });
        }
      }
      return res.status(200).json({ success: true, data: photos });
    }

    // 7. 사진 삭제 (🌟 실제 구글 드라이브 파일까지 삭제 연동)
    if (action === 'deleteDriverPhoto') {
      try {
        await fetch(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify({ action: 'delete', fileId: body.fileId }) });
      } catch (e) { console.log('드라이브 파일 삭제 실패 (무시됨)'); }

      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Photos!A1:G' });
      const data = response.data.values || [];
      let rowIndex = -1;
      for (let i = 0; i < data.length; i++) { if (data[i][6] && String(data[i][6]) === String(body.fileId) && String(data[i][1]) === String(body.driverId)) { rowIndex = i; break; } }
      if (rowIndex !== -1) {
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetId = sheetMeta.data.sheets.find(s => s.properties.title === 'Photos').properties.sheetId;
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] } });
      }
      return res.status(200).json({ success: true });
    }

    // 8. 당일 모니터링
    if (action === 'getAdminDailyStatus') {
      const prefix = formatYYMM(body.targetDate);
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${prefix}_호차배정!A2:D`, `${prefix}_배차리스트!A2:K`],
        });
        const users = response.data.valueRanges[0].values || [];
        const assign = response.data.valueRanges[1].values || [];
        const dispatch = response.data.valueRanges[2].values || [];
        
        const dateString = body.targetDate.substring(0, 10);
        let activeVehicles = new Set();
        let groupedDispatch = {}; 

        for (let row of dispatch) {
          if(!row[0] || String(row[0]).substring(0, 10) !== dateString) continue;
          let vehicle = String(row[1]);
          let clientName = String(row[3]);
          let arrivalTime = row[10] || "";
          activeVehicles.add(vehicle);

          let driverName = "미배정", driverPhone = "";
          for (let a of assign) {
            if(String(a[0]).substring(0, 10) === dateString && String(a[1]) === vehicle) {
              let aPhone = String(a[3]).replace(/[-']/g, '');
              for (let u of users) { if(String(u[3]).replace(/[-']/g, '') === aPhone) { driverName = u[1]; driverPhone = u[3]; break; } }
              break;
            }
          }
          
          let combineKey = vehicle + "_" + clientName;
          if(!groupedDispatch[combineKey]) {
            groupedDispatch[combineKey] = { vehicle, driverName, driverPhone, clientName, arrivalTime };
          } else {
            if(arrivalTime && !groupedDispatch[combineKey].arrivalTime) groupedDispatch[combineKey].arrivalTime = arrivalTime;
          }
        }
        return res.status(200).json({ success: true, data: Object.values(groupedDispatch), vehicleCount: activeVehicles.size });
      } catch (err) { return res.status(200).json({ success: false, message: '데이터 조회 실패' }); }
    }

    // 9. 월별 통계 분석 (운행거리 시트 부재 에러 완벽 방어 처리)
    if (action === 'getAdminMonthlyStats') {
      const prefix = formatYYMM(body.targetMonth);
      let dispatch = [], users = [], assign = [], mileageRows = [];
      try {
        const resMain = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: [`${prefix}_배차리스트!A2:K`, 'Users!A2:G', `${prefix}_호차배정!A2:D`],
        });
        dispatch = resMain.data.valueRanges[0].values || [];
        users = resMain.data.valueRanges[1].values || [];
        assign = resMain.data.valueRanges[2].values || [];
      } catch (err) { return res.status(200).json({ success: false, message: `${prefix}_배차 데이터가 없습니다.` }); }

      try {
        const mRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A2:H` });
        mileageRows = mRes.data.values || [];
      } catch(e) {} // 운행거리 시트가 아직 없어도 차트는 정상 출력되도록 방어

      let statsObj = {}, hospitalStats = {}, driverStats = {};
      const timeToMins = (t) => { if(!t || !t.includes(':')) return 0; const [h, m] = t.split(':'); return parseInt(h)*60 + parseInt(m); };

      for (let r of mileageRows) {
        let dName = String(r[1]);
        let finalKm = parseInt(r[7]) || 0;
        if (!driverStats[dName]) driverStats[dName] = { count: 0, clients: new Set(), endTimes: [], totalKm: 0 };
        driverStats[dName].totalKm += finalKm;
      }

      for (let row of dispatch) {
        if(!row[0]) continue;
        let dateKey = String(row[0]).substring(0, 10);
        if(!dateKey.startsWith(body.targetMonth)) continue;
        
        let vehicle = String(row[1]);
        let client = String(row[3]);
        let arrTime = row[10] || null;

        if(!statsObj[dateKey]) statsObj[dateKey] = { date: dateKey, vehicles: new Set(), total: 0, done: 0 };
        statsObj[dateKey].vehicles.add(vehicle);
        statsObj[dateKey].total++;
        if(arrTime) statsObj[dateKey].done++;

        if(!hospitalStats[client]) hospitalStats[client] = { count: 0, arrTimes: [] };
        hospitalStats[client].count++;
        if(arrTime) hospitalStats[client].arrTimes.push(timeToMins(arrTime));

        let driverName = "미배정";
        for (let a of assign) {
          if (String(a[0]).substring(0, 10) === dateKey && String(a[1]) === vehicle) {
            let aPhone = String(a[3]).replace(/[-']/g, '');
            for (let u of users) { if (String(u[3]).replace(/[-']/g, '') === aPhone) { driverName = u[1]; break; } }
            break;
          }
        }
        if (driverName === "미배정") continue;
        if (!driverStats[driverName]) driverStats[driverName] = { count: 0, clients: new Set(), endTimes: [], totalKm: 0 };
        driverStats[driverName].count++;
        driverStats[driverName].clients.add(client);
        if (arrTime) driverStats[driverName].endTimes.push({ date: dateKey, time: timeToMins(arrTime) });
      }

      let statsArray = Object.keys(statsObj).map(d => ({
        date: d, vehicleCount: statsObj[d].vehicles.size, totalCount: statsObj[d].total,
        doneCount: statsObj[d].done, missingCount: statsObj[d].total - statsObj[d].done
      })).sort((a, b) => a.date.localeCompare(b.date));

      let dStatsOut = [];
      for(let d in driverStats) {
         let eTimes = {};
         driverStats[d].endTimes.forEach(et => { if(!eTimes[et.date] || eTimes[et.date] < et.time) eTimes[et.date] = et.time; });
         let totalMins = 0, dayCount = 0;
         for(let dt in eTimes) { totalMins += eTimes[dt]; dayCount++; }
         let avgStr = dayCount > 0 ? `${String(Math.floor((totalMins/dayCount)/60)).padStart(2,'0')}:${String(Math.floor((totalMins/dayCount)%60)).padStart(2,'0')}` : "-";
         dStatsOut.push({ driverName: d, clientCount: driverStats[d].clients.size, totalDeliveries: driverStats[d].count, avgEndTime: avgStr, totalKm: driverStats[d].totalKm });
      }

      let hStatsOut = Object.keys(hospitalStats).map(h => {
         let tMins = hospitalStats[h].arrTimes.reduce((acc, val) => acc + val, 0);
         let count = hospitalStats[h].arrTimes.length;
         return { hospital: h, count: hospitalStats[h].count, avgTime: count > 0 ? `${String(Math.floor((tMins/count)/60)).padStart(2,'0')}:${String(Math.floor((tMins/count)%60)).padStart(2,'0')}` : "-" };
      }).sort((a,b) => b.count - a.count);

      return res.status(200).json({ success: true, data: statsArray, hospitalData: hStatsOut, driverData: dStatsOut });
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
        if (String(row[3]).replace(/-/g, '') === cleanPhone || String(row[2]) === loginId) return res.status(200).json({ success: false, message: '이미 등록된 기사님입니다.' });
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
      for (let i = 0; i < rows.length; i++) { if (String(rows[i][2]) === String(body.id)) { rowIndex = i; break; } }
      if (rowIndex !== -1) {
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetId = sheetMeta.data.sheets.find(s => s.properties.title === 'Users').properties.sheetId;
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] } });
        return res.status(200).json({ success: true });
      }
      return res.status(200).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 요청입니다.' });
  } catch (error) { return res.status(200).json({ success: false, message: `시스템 에러: ${error.message}` }); }
}
