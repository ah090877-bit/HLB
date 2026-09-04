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
    const envCreds = process.env.GOOGLE_CREDENTIALS;
    if (!envCreds) return res.status(200).json({ success: false, message: '구글 인증키 누락' });
    try { credentials = JSON.parse(envCreds.trim()); } 
    catch (e1) {
      try { credentials = JSON.parse(envCreds.replace(/\n/g, '\\n').replace(/\r/g, '')); } 
      catch (e2) { return res.status(200).json({ success: false, message: '인증키 JSON 오류' }); }
    }
    if (credentials && credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');

    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    
    const SPREADSHEET_ID = '1xcCTfZu6i7eGhha1IOh0kdNWW1ZDweEFNXh25PJf2O8';
    const FOLDER_ID = '12y-08UOW1srIpmFjlfaeLdbVv9ujWZRR';
    const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyppHv-1YCsvplSP7TOoS5q0djhye9-1oBFx-jJDZM0B9vZi2wI6s7GRpPK_d_E0g-Z/exec";

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
        
        let assignedVehicles = [];
        for (let row of assignData) {
          if(!row[0]) continue;
          if (String(row[0]).substring(0, 10) === dateString && String(row[3]).replace(/[-']/g, '') === fullPhone) { 
            if(!assignedVehicles.includes(row[1])) assignedVehicles.push(row[1]); 
          }
        }
        
        if (assignedVehicles.length === 0) return res.status(200).json({ success: true, data: [], message: '금일 배정된 호차가 없습니다.', vehicle: '' });

        let grouped = {};
        for (let row of dispatchData) {
          if(!row[6]) continue;
          let v = String(row[5]);
          if (String(row[6]).substring(0, 10) === dateString && assignedVehicles.includes(v)) {
            let clientName = String(row[3]);
            let key = v + "_" + clientName;
            let orderSeq = String(row[9]);
            let prodStr = `${row[2]}(${row[1]}개)`;
            
            if (!grouped[key]) {
              grouped[key] = {
                vehicle: v, orderSeq: orderSeq, clientName: clientName, clientAddr: row[4], clientPhone: row[7], orderNum: row[0],
                prodName: prodStr, qty: Number(row[1]), remarks: row[8] || '', arrivalTime: row[10] ? String(row[10]).substring(0,5) : ""
              };
            } else {
              let seqArray = grouped[key].orderSeq.split(',').map(s=>s.trim());
              if (!seqArray.includes(orderSeq) && orderSeq !== "undefined" && orderSeq !== "") { grouped[key].orderSeq += `, ${orderSeq}`; }
              grouped[key].prodName += `, ${prodStr}`;
              grouped[key].qty += Number(row[1]);
              if (row[10]) grouped[key].arrivalTime = String(row[10]).substring(0,5);
            }
          }
        }
        
        let dispatchList = Object.values(grouped);
        dispatchList.sort((a, b) => {
            if (a.vehicle !== b.vehicle) return a.vehicle.localeCompare(b.vehicle);
            let seqA = parseInt(String(a.orderSeq).split(',')[0]) || 999;
            let seqB = parseInt(String(b.orderSeq).split(',')[0]) || 999;
            return seqA - seqB;
        });
        return res.status(200).json({ success: true, vehicle: assignedVehicles.join(', '), data: dispatchList });
      } catch (err) { return res.status(200).json({ success: false, message: `${prefix}_배차리스트 데이터 조회에 실패했습니다.` }); }
    }

    if (action === 'recordArrivalTime') {
      const prefix = formatYYMM(body.targetDate);
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${prefix}_호차배정!A2:D`, `${prefix}_배차리스트!A2:K`],
        });
        
        let fullPhone = "";
        for (let row of (response.data.valueRanges[0].values || [])) { if (String(row[2]) === String(body.driverId)) { fullPhone = String(row[3]).replace(/[-']/g, ''); break; } }
        
        const dateString = body.targetDate.substring(0, 10);
        const targetVehicle = body.vehicle; 

        const dispatchData = response.data.valueRanges[2].values || [];
        const seqArray = String(body.orderSeq).split(',').map(s => s.trim()); 
        const kst = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
        const timeStr = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;

        for (let i = 0; i < dispatchData.length; i++) {
          let row = dispatchData[i];
          if(!row[6]) continue;
          if (String(row[6]).substring(0, 10) === dateString && String(row[5]) === targetVehicle && seqArray.includes(String(row[9]))) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID, range: `${prefix}_배차리스트!K${i + 2}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[timeStr]] }
            });
          }
        }
        return res.status(200).json({ success: true, arrivalTime: timeStr });
      } catch (err) { return res.status(200).json({ success: false, message: '기록 중 오류 발생' }); }
    }

    if (action === 'uploadDashboardPhoto') {
      try {
        const dateString = body.customDate.substring(0, 10);
        const stageClean = body.stage.replace(/\s/g, '');
        const prefix = formatYYMM(body.customDate); 

        try {
          const pRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_Photos!A:G` });
          for(let r of (pRes.data.values || [])) {
            if(r[0] && String(r[0]).substring(0,10) === dateString && String(r[1]) === String(body.driverId) && String(r[4]).replace(/\s/g,'') === stageClean) {
              return res.status(200).json({ success: false, message: '이미 해당 단계의 사진이 등록되어 있습니다.' });
            }
          }
        } catch(e) {}

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
        if (!gasResult.success) throw new Error("GAS 파일 업로드 실패");

        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: `${prefix}_Photos!A:H`, valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ body.customDate, body.driverId, driverName, carNum, body.stage, gasResult.url, gasResult.id, body.mileage || '0' ]] }
        });

        if (body.mileage) {
          const cleanPhone = originPhone.replace(/[-']/g, ''); 
          try {
            const mRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A2:H` });
            const mRows = mRes.data.values || [];
            let targetRowIndex = -1;
            
            for (let i = 0; i < mRows.length; i++) {
              if (String(mRows[i][0]).substring(0,10) === dateString && String(mRows[i][1]) === driverName) { 
                targetRowIndex = i + 2; break; 
              }
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
              const uRowRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A${targetRowIndex}:G${targetRowIndex}` });
              const rowData = uRowRes.data.values[0] || [];
              const startKm = colLetter === 'D' ? parseInt(body.mileage) : parseInt(rowData[3]) || 0;
              const endKm = colLetter === 'G' ? parseInt(body.mileage) : parseInt(rowData[6]) || 0;
              
              if (startKm > 0 && endKm > 0 && endKm >= startKm) {
                await sheets.spreadsheets.values.update({
                  spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!H${targetRowIndex}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[endKm - startKm]] }
                });
              }
            } else if (targetRowIndex === -1) {
              const newRow = [dateString, driverName, `'${cleanPhone}`, '', '', '', '', '0'];
              if(colLetter==='D') newRow[3] = body.mileage; else if(colLetter==='E') newRow[4] = body.mileage; else if(colLetter==='F') newRow[5] = body.mileage; else if(colLetter==='G') newRow[6] = body.mileage;
              await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_운행거리!A:H`, valueInputOption: 'USER_ENTERED', requestBody: { values: [newRow] } });
            }
          } catch(se) {} 
        }
        return res.status(200).json({ success: true, url: gasResult.url });
      } catch (err) { return res.status(200).json({ success: false, message: `서버 전송 오류: ${err.message}` }); }
    }

    if (action === 'getDriverPhotos') {
      const prefix = formatYYMM(body.targetMonth); 
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_Photos!A2:H` });
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
      } catch (e) { return res.status(200).json({ success: true, data: [] }); }
    }

    if (action === 'deleteDriverPhoto') {
      try { await fetch(GAS_WEB_APP_URL, { method: 'POST', body: JSON.stringify({ action: 'delete', fileId: body.fileId }) }); } catch (e) {}
      
      const prefix = formatYYMM(body.dateKey); 
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${prefix}_Photos!A1:G` });
        const data = response.data.values || [];
        let rowIndex = -1;
        for (let i = 0; i < data.length; i++) { if (data[i][6] && String(data[i][6]) === String(body.fileId) && String(data[i][1]) === String(body.driverId)) { rowIndex = i; break; } }
        if (rowIndex !== -1) {
          const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
          const sheetId = sheetMeta.data.sheets.find(s => s.properties.title === `${prefix}_Photos`).properties.sheetId;
          await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] } });
        }
      } catch(e) {}
      return res.status(200).json({ success: true });
    }

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
          if(!row[6] || String(row[6]).substring(0, 10) !== dateString) continue;
          let vehicle = String(row[5]);
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
          if(!groupedDispatch[combineKey]) { groupedDispatch[combineKey] = { vehicle, driverName, driverPhone, clientName, arrivalTime }; } 
          else { if(arrivalTime && !groupedDispatch[combineKey].arrivalTime) groupedDispatch[combineKey].arrivalTime = arrivalTime; }
        }
        return res.status(200).json({ success: true, data: Object.values(groupedDispatch), vehicleCount: activeVehicles.size });
      } catch (err) { return res.status(200).json({ success: false, message: '데이터 조회 실패' }); }
    }

    // 🌟 9. 월별 통계 분석 (무거운 차트 제거 및 초고속 O(N) 해시맵 엔진으로 전면 개편 - 프리징 완벽 해결)
    if (action === 'getAdminMonthlyStats') {
      const prefix = formatYYMM(body.targetMonth);
      let dispatch = [], users = [], assign = [];
      try {
        const resMain = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: [`${prefix}_배차리스트!A2:K`, 'Users!A2:G', `${prefix}_호차배정!A2:D`],
        });
        dispatch = resMain.data.valueRanges[0].values || [];
        users = resMain.data.valueRanges[1].values || [];
        assign = resMain.data.valueRanges[2].values || [];
      } catch (err) { return res.status(200).json({ success: false, message: `${prefix}_배차 데이터가 없습니다.` }); }

      let userMap = {};
      for (let u of users) {
        if(u[3]) userMap[String(u[3]).replace(/[-']/g, '')] = u[1];
      }

      let assignMap = {};
      for (let a of assign) {
        if(!a[0] || !a[1] || !a[3]) continue;
        let d = String(a[0]).substring(0, 10);
        let p = String(a[3]).replace(/[-']/g, '');
        if (userMap[p]) assignMap[d + "_" + String(a[1])] = userMap[p];
      }

      let driverDaily = {}; 
      const timeToMins = (t) => { if(!t || !t.includes(':')) return -1; const [h, m] = t.split(':'); return parseInt(h)*60 + parseInt(m); };

      for (let row of dispatch) {
        if(!row[6]) continue;
        let dateKey = String(row[6]).substring(0, 10);
        if(!dateKey.startsWith(body.targetMonth)) continue;
        
        let driverName = assignMap[dateKey + "_" + String(row[5])];
        if (!driverName) continue;

        if(!driverDaily[driverName]) driverDaily[driverName] = {};
        if(!driverDaily[driverName][dateKey]) driverDaily[driverName][dateKey] = { times: [], count: 0 };
        
        driverDaily[driverName][dateKey].count++;
        let m = timeToMins(row[10]);
        if (m !== -1) driverDaily[driverName][dateKey].times.push(m);
      }

      let driverData = [];
      for(let dName in driverDaily) {
        let totalCount = 0;
        let firstMins = 0, firstDays = 0;
        let lastMins = 0, lastDays = 0;
        let totalDuration = 0, validIntervals = 0;

        for (let dt in driverDaily[dName]) {
          let daily = driverDaily[dName][dt];
          totalCount += daily.count;
          if (daily.times.length > 0) {
            daily.times.sort((a,b)=>a-b);
            firstMins += daily.times[0]; firstDays++;
            lastMins += daily.times[daily.times.length - 1]; lastDays++;
            
            if (daily.times.length > 1) {
               totalDuration += (daily.times[daily.times.length - 1] - daily.times[0]);
               validIntervals += (daily.times.length - 1);
            }
          }
        }
        
        let formatTime = (m) => {
          if (m === 0) return "-";
          let hh = Math.floor(m / 60); let mm = Math.floor(m % 60);
          return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
        };

        driverData.push({
          driverName: dName,
          totalDeliveries: totalCount,
          avgFirst: firstDays > 0 ? formatTime(firstMins / firstDays) : "-",
          avgLast: lastDays > 0 ? formatTime(lastMins / lastDays) : "-",
          avgPerDelivery: validIntervals > 0 ? Math.round(totalDuration / validIntervals) + "분" : "-"
        });
      }

      driverData.sort((a,b) => b.totalDeliveries - a.totalDeliveries);
      return res.status(200).json({ success: true, driverData });
    }

    if (action === 'getDriverList') {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:G' });
      let drivers = [];
      for (let row of (response.data.values || [])) {
        if (row[0] === 'driver') drivers.push({ name: row[1], id: String(row[2]), phone: row[3], carNumber: row[5] || '미등록' });
      }
      return res.status(200).json({ success: true, data: drivers });
    }

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

    if (action === 'getDailyReport') {
      const prefix = formatYYMM(body.targetDate);
      const dateString = body.targetDate.substring(0, 10);
      try {
        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: ['Users!A2:G', `${prefix}_호차배정!A2:D`, `${prefix}_배차리스트!A2:K`, `${prefix}_운행거리!A2:H`],
        });
        const users = response.data.valueRanges[0].values || [];
        const assign = response.data.valueRanges[1].values || [];
        const dispatch = response.data.valueRanges[2].values || [];
        const mileage = response.data.valueRanges[3] ? response.data.valueRanges[3].values || [] : [];

        let reportData = {};

        for (let row of dispatch) {
          if (!row[6] || String(row[6]).substring(0, 10) !== dateString) continue;
          let vehicle = String(row[5]);
          let clientName = String(row[3]).replace(/\s*\(\d+ea\)/gi, '').trim();
          let orderSeq = parseInt(row[9]) || 999;
          let arrTime = row[10] || "";
          let remarks = row[8] || "";

          if (!reportData[vehicle]) {
            let driverName = "미배정";
            for (let a of assign) {
              if (String(a[0]).substring(0, 10) === dateString && String(a[1]) === vehicle) {
                let aPhone = String(a[3]).replace(/[-']/g, '');
                for (let u of users) { if (String(u[3]).replace(/[-']/g, '') === aPhone) { driverName = u[1]; break; } }
                break;
              }
            }

            let startKm = "", endKm = "";
            for (let m of mileage) {
              if (String(m[0]).substring(0, 10) === dateString && String(m[1]) === driverName) {
                startKm = m[4] || m[3] || ""; 
                endKm = m[5] || m[6] || ""; 
                break;
              }
            }
            reportData[vehicle] = { vehicle: vehicle, driverName: driverName, startKm: startKm, endKm: endKm, clientsMap: {} };
          }

          if (!reportData[vehicle].clientsMap[clientName]) {
            reportData[vehicle].clientsMap[clientName] = { name: clientName, boxCount: 0, arrTime: arrTime, remarks: remarks, orderSeq: orderSeq };
          } else {
            if (orderSeq < reportData[vehicle].clientsMap[clientName].orderSeq) {
              reportData[vehicle].clientsMap[clientName].orderSeq = orderSeq;
            }
            if (arrTime && !reportData[vehicle].clientsMap[clientName].arrTime) {
               reportData[vehicle].clientsMap[clientName].arrTime = arrTime;
            }
          }
          reportData[vehicle].clientsMap[clientName].boxCount++;
        }

        for (let v in reportData) {
           reportData[v].clients = Object.values(reportData[v].clientsMap).sort((a,b) => a.orderSeq - b.orderSeq);
        }

        return res.status(200).json({ success: true, data: reportData });
      } catch (err) { return res.status(200).json({ success: false, message: '일지 데이터를 불러올 수 없습니다.' }); }
    }

    return res.status(400).json({ success: false, message: '알 수 없는 요청입니다.' });
  } catch (error) { return res.status(200).json({ success: false, message: `시스템 에러: ${error.message}` }); }
}
