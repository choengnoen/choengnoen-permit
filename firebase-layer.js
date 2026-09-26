/* ==========================================================================
   firebase-layer.js — ชั้นเชื่อมต่อ Firebase (Authentication + Firestore)
   ระบบงานขออนุญาตในเขตทาง หมวดทางหลวงเชิงเนิน
   โคลนโครงสร้างจากระบบงานโจรกรรม (ล็อกอิน ทีม สิทธิ์ 3 ระดับ สถานะออนไลน์ ถังขยะ บันทึกประวัติ)
   แต่ใช้โปรเจกต์ Firebase คนละโปรเจกต์ — ข้อมูลไม่ปนกับระบบอื่น

   ทำหน้าที่:
     - ล็อกอิน/ล็อกเอาต์ (Firebase Auth) และจัดการทีม (เพิ่ม/ลบ/ตั้งรหัสผ่านใหม่/ตั้งผู้ดูแล)
     - อ่านข้อมูลแบบ realtime (onSnapshot) + แคชในเครื่อง เปิดครั้งต่อไปเร็วและอ่านเฉพาะส่วนที่เปลี่ยน
     - เขียนข้อมูลพร้อมบันทึก activity_log ในคำสั่งเดียวกัน (atomic batch)
     - soft delete / restore / ลบถาวร (ลบถาวร = เจ้าของระบบหรือผู้ดูแลระบบ — บังคับที่ Firestore Rules)
     - เติมสายทางตั้งต้น และนำเข้าเขตพื้นที่/สายทางจากไฟล์ Excel (เช่น zones-import.xlsx ชุดเดียวกับงานโจรกรรม)

   คอลเลกชัน: permits (เรื่องขออนุญาต), team, routes, zones (เขตพื้นที่), activity_log, config, presence

   หมายเหตุ: ค่า firebaseConfig ด้านล่างเป็นค่าสาธารณะโดยออกแบบ (ไม่ใช่รหัสลับ) ความปลอดภัยจริงอยู่ที่ firestore.rules
   ========================================================================== */
(function () {
  'use strict';

  // ▼▼▼ วางค่าจาก Firebase Console ตรงนี้ (โปรเจกต์ใหม่สำหรับงานขออนุญาตในเขตทาง) ▼▼▼
  // Firebase Console → Project settings (⚙) → General → Your apps → Web app (</>) → SDK setup and configuration → Config
  // ขั้นตอนละเอียดดูใน "คู่มือติดตั้ง-อ่านก่อน.md"
  const firebaseConfig = {
    apiKey: "AIzaSyBp-jNLr9loOvT8miP9C9JXlVi6jRrgMfo",
    authDomain: "choengnoen-permit.firebaseapp.com",
    projectId: "choengnoen-permit",
    storageBucket: "choengnoen-permit.firebasestorage.app",
    messagingSenderId: "399113847136",
    appId: "1:399113847136:web:a071de452d0ec183171e05"
  };
  // ▲▲▲ ─────────────────────────────────────────────────────────────── ▲▲▲

  // ระบบล็อกอินด้วยชื่อ-นามสกุล แต่ Firebase Auth ต้องการอีเมล จึงสร้างอีเมลสังเคราะห์ให้แต่ละคน
  // (โดเมน .invalid เป็นโดเมนที่ไม่มีอยู่จริงตามมาตรฐาน — ไม่มีการส่งอีเมลใดๆ ออกไปทั้งสิ้น)
  const EMAIL_DOMAIN = 'permit.invalid';
  const CASE_COL = 'permits';

  const FBL = {};
  window.FBL = FBL;
  // ยังไม่ได้วางค่า firebaseConfig → หน้าเว็บจะแสดงข้อความแนะนำแทนหน้าล็อกอิน
  FBL.configured = !/^YOUR_/.test(String(firebaseConfig.apiKey || '')) && !/^YOUR_/.test(String(firebaseConfig.projectId || ''));

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  if (FBL.configured) {
    try {
      db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
        console.warn('Firestore offline cache unavailable:', e && e.code);
      });
    } catch (e) { /* เบราว์เซอร์ที่ไม่รองรับ — ทำงานต่อแบบไม่มีแคช */ }
  }

  FBL.user = null;          // { uid, name, isOwner, isAdmin } เมื่อล็อกอินแล้ว
  FBL.onError = null;       // callback(message) สำหรับข้อผิดพลาดจาก realtime listener
  let team = [];            // [{ uid, name, email, isOwner, isAdmin }]
  let suppressAuthEvents = false;

  /* ---------- ข้อความผิดพลาดภาษาไทย ---------- */
  function thErr(e) {
    const code = (e && e.code) || '';
    const map = {
      'auth/invalid-credential': 'รหัสผ่านไม่ถูกต้อง',
      'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
      'auth/invalid-login-credentials': 'รหัสผ่านไม่ถูกต้อง',
      'auth/user-not-found': 'ไม่พบบัญชีนี้ในระบบ',
      'auth/too-many-requests': 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
      'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่',
      'auth/weak-password': 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร',
      'auth/email-already-in-use': 'เกิดบัญชีซ้ำโดยบังเอิญ กรุณาลองอีกครั้ง',
      'auth/requires-recent-login': 'กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ก่อนเปลี่ยนรหัสผ่าน',
      'auth/operation-not-allowed': 'ยังไม่ได้เปิดการเข้าสู่ระบบแบบ Email/Password ใน Firebase Console',
      'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase (Authentication → Settings → Authorized domains)',
      'permission-denied': 'ไม่มีสิทธิ์ทำรายการนี้ (ตรวจสอบว่าได้วางกฎ firestore.rules แล้ว และล็อกอินด้วยบัญชีที่มีสิทธิ์)',
      'unavailable': 'เชื่อมต่อฐานข้อมูลไม่ได้ในขณะนี้ กรุณาลองใหม่',
      'failed-precondition': 'ฐานข้อมูลไม่พร้อมทำรายการนี้'
    };
    return map[code] || ((e && e.message) ? e.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  }
  FBL.errorText = thErr;

  function nowIso() { return new Date().toISOString(); }
  function randomId(n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').slice(0, n);
  }
  function newEmail() { return 'm-' + randomId(12) + '@' + EMAIL_DOMAIN; }
  function requireOwner() {
    if (!FBL.user || !FBL.user.isOwner) throw new Error('เฉพาะเจ้าของระบบเท่านั้น');
  }
  // เจ้าของระบบ หรือ ผู้ดูแลระบบ (isAdmin) — ทุกอย่างยกเว้นจัดการทีม
  function requirePrivileged() {
    if (!FBL.user || !(FBL.user.isOwner || FBL.user.isAdmin)) throw new Error('เฉพาะเจ้าของระบบหรือผู้ดูแลระบบเท่านั้น');
  }
  // Firestore ไม่รับ undefined และ NaN/Infinity
  function clean(o) {
    const out = {};
    Object.keys(o).forEach(function (k) {
      let v = o[k];
      if (v === undefined) return;
      if (typeof v === 'number' && !isFinite(v)) v = null;
      out[k] = v;
    });
    return out;
  }
  function asJsonString(v) {
    if (v === undefined || v === null || v === '') return '[]';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  /* ---------- ทีม / ล็อกอิน ---------- */
  // อ่านรายชื่อทีมได้ก่อนล็อกอิน (ใช้แสดงรายชื่อให้เลือกในหน้าล็อกอิน) — มีเฉพาะชื่อ/อีเมลสังเคราะห์/สถานะเจ้าของ ไม่มีรหัสผ่าน
  FBL.loadTeam = async function () {
    const snap = await db.collection('team').get();
    team = snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
    team.sort(function (a, b) { return (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'th'); });
    return team.slice();
  };
  FBL.team = function () { return team.slice(); };

  // ต้องเรียกครั้งเดียวตอนเริ่มระบบ — cb(user|null, errorMessage?)
  FBL.onAuth = function (cb) {
    auth.onAuthStateChanged(async function (u) {
      if (suppressAuthEvents) return;
      if (!u) { FBL.user = null; cb(null); return; }
      try {
        const d = await db.collection('team').doc(u.uid).get();
        if (!d.exists) {
          FBL.user = null;
          await auth.signOut();
          cb(null, 'บัญชีนี้ไม่ได้อยู่ในรายชื่อเจ้าหน้าที่ กรุณาติดต่อเจ้าของระบบ');
          return;
        }
        FBL.user = { uid: u.uid, name: d.data().name, isOwner: !!d.data().isOwner, isAdmin: !!d.data().isAdmin };
        cb(FBL.user);
      } catch (e) {
        FBL.user = null;
        cb(null, thErr(e));
      }
    });
  };

  FBL.login = async function (name, password) {
    const m = team.find(function (x) { return x.name === String(name || '').trim(); });
    if (!m) throw new Error('ไม่พบชื่อนี้ในระบบ');
    try {
      await auth.signInWithEmailAndPassword(m.email, password);
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.logout = async function () {
    // แจ้งว่าออฟไลน์ก่อนออกจากระบบ (รอไม่เกิน 2 วินาที ถ้าเน็ตหลุดก็ข้ามไป)
    try { await Promise.race([presenceWrite(false), new Promise(function (r) { setTimeout(r, 2000); })]); } catch (e) { /* ข้าม */ }
    FBL.stopPresence();
    await auth.signOut();
    FBL.stopAll();
  };

  /* ---------- สถานะออนไลน์ (เจ้าของระบบ/ผู้ดูแลเห็นใน "ระบบควบคุมการเข้าใช้งาน") ----------
     ทุกคนที่ล็อกอินอยู่เขียนเอกสาร presence/{uid} ของตัวเอง 1 ครั้งทุก 2 นาที เฉพาะตอนที่เปิดหน้าเว็บอยู่ */
  const PRESENCE_EVERY_MS = 120000;
  let presenceTimer = null;
  let presenceOnVisible = null;
  let presenceOnHide = null;
  function presenceWrite(online) {
    if (!FBL.user) return Promise.resolve();
    return db.collection('presence').doc(FBL.user.uid).set({
      name: FBL.user.name,
      online: online,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function () { /* ข้ามเงียบๆ */ });
  }
  FBL.startPresence = function () {
    FBL.stopPresence();
    presenceWrite(true);
    presenceTimer = setInterval(function () { if (document.visibilityState === 'visible') presenceWrite(true); }, PRESENCE_EVERY_MS);
    presenceOnVisible = function () { if (document.visibilityState === 'visible') presenceWrite(true); };
    presenceOnHide = function () { presenceWrite(false); };
    document.addEventListener('visibilitychange', presenceOnVisible);
    window.addEventListener('pagehide', presenceOnHide);
  };
  FBL.stopPresence = function () {
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (presenceOnVisible) { document.removeEventListener('visibilitychange', presenceOnVisible); presenceOnVisible = null; }
    if (presenceOnHide) { window.removeEventListener('pagehide', presenceOnHide); presenceOnHide = null; }
  };

  // ตั้งเจ้าของระบบคนแรก — Rules อนุญาตเฉพาะตอนที่ยังไม่มีเอกสาร config/bootstrap และจะปิดประตูนี้ทันทีหลังสำเร็จ
  FBL.bootstrapOwner = async function (name, password) {
    name = String(name || '').trim();
    if (!name) throw new Error('กรอกชื่อ-นามสกุลก่อน');
    suppressAuthEvents = true;
    try {
      const email = newEmail();
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const uid = cred.user.uid;
      try {
        const batch = db.batch();
        batch.set(db.collection('team').doc(uid), { name: name, email: email, isOwner: true, isAdmin: false, createdAt: nowIso() });
        batch.set(db.collection('config').doc('bootstrap'), { uid: uid, at: nowIso() });
        await batch.commit();
      } catch (e) {
        try { await cred.user.delete(); } catch (_) { /* ล้างบัญชีที่ค้าง */ }
        throw e;
      }
      FBL.user = { uid: uid, name: name, isOwner: true, isAdmin: false };
      team = [{ uid: uid, name: name, email: email, isOwner: true, isAdmin: false }];
      return FBL.user;
    } catch (e) {
      throw new Error(thErr(e));
    } finally {
      suppressAuthEvents = false;
    }
  };

  // สร้างบัญชี Auth โดยไม่ทำให้เจ้าของระบบหลุดจากเซสชัน (ใช้แอปรองแยกต่างหาก)
  async function createAuthUserSecondary(email, password) {
    const sec = firebase.apps.find(function (a) { return a.name === 'secondary'; }) || firebase.initializeApp(firebaseConfig, 'secondary');
    const cred = await sec.auth().createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await sec.auth().signOut();
    return uid;
  }

  FBL.addMember = async function (name, password, isAdmin) {
    requireOwner();
    name = String(name || '').trim();
    if (!name) throw new Error('กรอกชื่อ-นามสกุลก่อน');
    if (team.some(function (t) { return t.name === name; })) throw new Error('มีชื่อนี้เป็นเจ้าหน้าที่อยู่แล้ว');
    try {
      const email = newEmail();
      const uid = await createAuthUserSecondary(email, password);
      await db.collection('team').doc(uid).set({ name: name, email: email, isOwner: false, isAdmin: !!isAdmin, createdAt: nowIso() });
      team.push({ uid: uid, name: name, email: email, isOwner: false, isAdmin: !!isAdmin });
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.removeMember = async function (name) {
    requireOwner();
    const m = team.find(function (t) { return t.name === name; });
    if (!m) return;
    if (m.isOwner) throw new Error('ลบเจ้าของระบบไม่ได้');
    try {
      await db.collection('team').doc(m.uid).delete();
      team = team.filter(function (t) { return t.uid !== m.uid; });
    } catch (e) { throw new Error(thErr(e)); }
  };

  // ตั้ง/ยกเลิกสิทธิ์ "ผู้ดูแลระบบ" (เจ้าของระบบเท่านั้นที่ตั้งได้) — ผู้ดูแลทำได้ทุกอย่างเหมือนเจ้าของ ยกเว้นจัดการทีม
  FBL.setMemberAdmin = async function (name, makeAdmin) {
    requireOwner();
    const m = team.find(function (t) { return t.name === name; });
    if (!m) throw new Error('ไม่พบชื่อนี้ในรายชื่อ');
    if (m.isOwner) throw new Error('เจ้าของระบบมีสิทธิ์ครบอยู่แล้ว');
    try {
      await db.collection('team').doc(m.uid).update({ isAdmin: !!makeAdmin });
      m.isAdmin = !!makeAdmin;
    } catch (e) { throw new Error(thErr(e)); }
  };

  // เจ้าของระบบไม่สามารถแก้รหัสผ่านของ "คนอื่น" ตรงๆ ได้ (ข้อจำกัดของ Firebase ฝั่งเบราว์เซอร์)
  // จึงสร้างบัญชีล็อกอินใหม่ให้คนนั้นด้วยรหัสผ่านใหม่ แล้วสลับรายชื่อ — ผลต่อผู้ใช้เหมือนตั้งรหัสผ่านใหม่
  FBL.resetMemberPassword = async function (name, newPassword) {
    requireOwner();
    const m = team.find(function (t) { return t.name === name; });
    if (!m) throw new Error('ไม่พบชื่อนี้ในรายชื่อ');
    try {
      if (FBL.user && m.uid === FBL.user.uid) {
        await auth.currentUser.updatePassword(newPassword);
        return;
      }
      const email = newEmail();
      const uid = await createAuthUserSecondary(email, newPassword);
      const batch = db.batch();
      batch.delete(db.collection('team').doc(m.uid));
      batch.set(db.collection('team').doc(uid), { name: m.name, email: email, isOwner: !!m.isOwner, isAdmin: !!m.isAdmin, createdAt: nowIso() });
      await batch.commit();
      team = team.filter(function (t) { return t.uid !== m.uid; });
      team.push({ uid: uid, name: m.name, email: email, isOwner: !!m.isOwner, isAdmin: !!m.isAdmin });
    } catch (e) { throw new Error(thErr(e)); }
  };

  /* ---------- อ่านข้อมูลแบบ realtime ---------- */
  const subs = {};
  // คืน Promise ที่ resolve เมื่อได้ข้อมูลชุดแรก; การเปลี่ยนแปลงถัดไปเรียก onChange(collection, docs)
  FBL.watch = function (col, onChange) {
    if (subs[col]) { subs[col].onChange = onChange || subs[col].onChange; return subs[col].first; }
    const s = subs[col] = { docs: [], firstDone: false, onChange: onChange };
    s.first = new Promise(function (resolve) {
      s.unsub = db.collection(col).onSnapshot(function (snap) {
        s.docs = snap.docs.map(function (d) { return Object.assign({}, d.data(), { __id: d.id }); });
        if (!s.firstDone) { s.firstDone = true; resolve(s.docs); }
        else if (s.onChange) { try { s.onChange(col, s.docs); } catch (e) { console.error(e); } }
      }, function (err) {
        console.error('watch ' + col + ' failed', err);
        if (FBL.onError && col !== 'presence') FBL.onError(thErr(err));
        if (!s.firstDone) { s.firstDone = true; resolve([]); }
      });
    });
    return s.first;
  };
  FBL.docs = function (col) { return subs[col] ? subs[col].docs : []; };
  FBL.stopAll = function () {
    Object.keys(subs).forEach(function (k) { if (subs[k].unsub) subs[k].unsub(); delete subs[k]; });
  };

  /* ---------- เขียนข้อมูลเรื่องขออนุญาต (+ activity_log ใน batch เดียวกัน) ---------- */
  function logRef() { return db.collection('activity_log').doc(); }
  function logEntry(action, sheetName, recordId, snapshot) {
    return {
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      actorName: FBL.user ? FBL.user.name : '(ไม่ทราบผู้ทำรายการ)',
      actorUid: FBL.user ? FBL.user.uid : '',
      action: action,
      sheetName: sheetName,
      recordId: recordId,
      snapshot: JSON.stringify(snapshot || {})
    };
  }
  async function readBefore(ref) {
    try { const d = await ref.get(); return d.exists ? d.data() : {}; } catch (e) { return {}; }
  }

  // docs (เช็กลิสต์เอกสาร) เก็บเป็น map { key: true } — เขียนทับทั้งก้อน (ไม่ merge ลึก) เพื่อให้ยกเลิกติ๊กได้จริง
  FBL.savePermit = async function (rec, isNew) {
    const ref = db.collection(CASE_COL).doc(String(rec.id));
    const data = clean(Object.assign({}, rec, { docs: rec.docs || {} }));
    let before = {};
    if (!isNew) before = await readBefore(ref);
    if (isNew) { data.deletedAt = null; data.deletedBy = ''; }
    const batch = db.batch();
    batch.set(ref, data, { mergeFields: Object.keys(data) });
    batch.set(logRef(), logEntry(isNew ? 'add' : 'update', CASE_COL, rec.id, isNew ? {} : before));
    await batch.commit();
  };

  FBL.softDeletePermit = async function (id) {
    const ref = db.collection(CASE_COL).doc(String(id));
    const before = await readBefore(ref);
    const batch = db.batch();
    batch.update(ref, { deletedAt: nowIso(), deletedBy: FBL.user ? FBL.user.name : '' });
    batch.set(logRef(), logEntry('delete', CASE_COL, id, before));
    await batch.commit();
  };

  FBL.restorePermit = async function (id) {
    const ref = db.collection(CASE_COL).doc(String(id));
    const batch = db.batch();
    batch.update(ref, { deletedAt: null, deletedBy: '' });
    batch.set(logRef(), logEntry('restore', CASE_COL, id, {}));
    await batch.commit();
  };

  FBL.permanentDeletePermit = async function (id) {
    requirePrivileged();
    const ref = db.collection(CASE_COL).doc(String(id));
    const before = await readBefore(ref);
    const batch = db.batch();
    batch.delete(ref);
    batch.set(logRef(), logEntry('permanentDelete', CASE_COL, id, before));
    await batch.commit();
  };

  /* ---------- สายทาง และเขตพื้นที่รับผิดชอบ ---------- */
  function routeData(r) {
    return clean({
      highway: String(r.highway), controlNo: r.controlNo || '', section: r.section || '',
      kmRanges: asJsonString(r.kmRanges),
      distanceActual: r.distanceActual === undefined ? null : r.distanceActual,
      distance2Lane: r.distance2Lane === undefined ? null : r.distance2Lane,
      asphalt: r.asphalt === undefined ? null : r.asphalt,
      concrete: r.concrete === undefined ? null : r.concrete,
      workQty: r.workQty === undefined ? null : r.workQty,
      // สถานะสายทาง: active = หมวดฯ ดูแลอยู่ / transferred = โอนให้หมวดอื่นแล้ว (เก็บไว้เพื่อคงเรื่องเก่า)
      status: r.status === 'transferred' ? 'transferred' : 'active',
      transferredDate: r.transferredDate || '',
      transferNote: r.transferNote || '',
      updatedAt: r.updatedAt || ''
    });
  }
  FBL.saveRoute = async function (r) {
    await db.collection('routes').doc(String(r.highway)).set(routeData(r), { merge: true });
  };
  FBL.deleteRoute = async function (highway) {
    await db.collection('routes').doc(String(highway)).delete();
  };

  // เขตพื้นที่รับผิดชอบ: ช่วง กม. (หน่วยเมตร) → ตำบล/อำเภอ/จังหวัด/หมู่ (+ สภ.) — ใช้เติมข้อมูลอัตโนมัติตอนบันทึกเรื่อง
  function zoneData(z) {
    return clean({
      id: String(z.id), highway: String(z.highway || ''),
      kmStart: Number(z.kmStart) || 0, kmEnd: Number(z.kmEnd) || 0,
      side: z.side || '',
      station: z.station || '', tambon: z.tambon || '', amphoe: z.amphoe || '', changwat: z.changwat || '',
      moobans: asJsonString(z.moobans),
      updatedAt: z.updatedAt || ''
    });
  }
  FBL.saveZone = async function (z) {
    requirePrivileged();
    await db.collection('zones').doc(String(z.id)).set(zoneData(z), { merge: true });
  };
  FBL.deleteZone = async function (id) {
    requirePrivileged();
    await db.collection('zones').doc(String(id)).delete();
  };

  async function commitInChunks(writes, progress, label) {
    const CHUNK = 400; // Firestore จำกัด 500 คำสั่งต่อ batch
    let done = 0;
    for (let i = 0; i < writes.length; i += CHUNK) {
      const batch = db.batch();
      writes.slice(i, i + CHUNK).forEach(function (w) { if (w.merge) batch.set(w.ref, w.data, { merge: true }); else batch.set(w.ref, w.data); });
      await batch.commit();
      done += Math.min(CHUNK, writes.length - i);
      if (progress) progress(label + ': ' + done + '/' + writes.length);
    }
  }

  // เติมสายทางตั้งต้นของหมวดฯ (ข้ามสายที่มีอยู่แล้ว ไม่ทับที่แก้ไว้ — รันซ้ำได้ปลอดภัย)
  FBL.seedRoutes = async function (routes, progress) {
    requirePrivileged();
    const today = nowIso().slice(0, 10);
    const rSnap = await db.collection('routes').get();
    const have = new Set(rSnap.docs.map(function (d) { return d.id; }));
    const writes = (routes || []).filter(function (r) { return !have.has(String(r.highway)); }).map(function (r) {
      return { ref: db.collection('routes').doc(String(r.highway)), data: routeData(Object.assign({ updatedAt: today }, r)), merge: true };
    });
    await commitInChunks(writes, progress, 'สายทาง');
    return ['สายทาง: เพิ่มใหม่ ' + writes.length + ' สาย (มีอยู่แล้ว ' + ((routes || []).length - writes.length) + ')'];
  };

  /* ==========================================================================
     นำเข้าเขตพื้นที่ / สายทาง จากไฟล์ Excel (เจ้าของระบบ/ผู้ดูแลระบบ)
     - ใช้ไฟล์รูปแบบเดียวกับระบบงานโจรกรรม เช่น zones-import.xlsx (แท็บ zones: id, route, kmStart, kmEnd, side, station, tambon, amphoe, changwat, moobans)
     - กม. ในไฟล์เป็นทศนิยม (เช่น 223.650) ตัวนำเข้าแปลงเป็นเมตร / "ทล.3145" เป็น "3145" ให้
     - รันซ้ำได้ปลอดภัย: ใช้ id เดิมเป็นรหัสเอกสาร (เขียนทับของเดิม ไม่เกิดซ้ำ)
     ========================================================================== */
  function serialToDate(n) { return new Date(Math.round((n - 25569) * 86400000)); }
  function toDateStr(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') return serialToDate(v).toISOString().slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : String(v);
  }
  function toNum(v) { if (v === '' || v === null || v === undefined) return ''; const n = Number(v); return isFinite(n) ? n : ''; }
  function toNumOrNull(v) { const n = toNum(v); return n === '' ? null : n; }
  function toStr(v) { return (v === null || v === undefined) ? '' : String(v); }
  function stripHw(v) { return toStr(v).replace(/^\s*ทล\.?\s*/, '').trim(); }
  function kmToMeters(v) { const n = toNum(v); return n === '' ? null : Math.round(n * 1000); }
  function parseJsonArr(v) {
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function mapRoute(r) {
    let control = r.controlNo;
    if (typeof control === 'number') control = String(control).padStart(4, '0');
    const ranges = parseJsonArr(r.kmRanges).map(function (p) { return [Math.round(Number(p[0]) * 1000), Math.round(Number(p[1]) * 1000)]; });
    return {
      highway: stripHw(r.highway), controlNo: toStr(control), section: toStr(r.section),
      kmRanges: JSON.stringify(ranges),
      distanceActual: toNumOrNull(r.distanceActual), distance2Lane: toNumOrNull(r.distance2Lane),
      asphalt: toNumOrNull(r.asphalt), concrete: toNumOrNull(r.concrete), workQty: toNumOrNull(r.workQty),
      updatedAt: toDateStr(r.updatedAt)
    };
  }
  function mapZone(r) {
    return {
      id: toStr(r.id), highway: stripHw(r.route !== undefined && r.route !== '' ? r.route : r.highway),
      kmStart: kmToMeters(r.kmStart) || 0, kmEnd: kmToMeters(r.kmEnd) || 0,
      side: toStr(r.side),
      station: toStr(r.station), tambon: toStr(r.tambon), amphoe: toStr(r.amphoe), changwat: toStr(r.changwat),
      moobans: JSON.stringify(parseJsonArr(r.moobans).map(String)),
      updatedAt: toDateStr(r.updatedAt)
    };
  }

  // XLSXlib = ตัวแปร XLSX (SheetJS) ที่หน้าเว็บโหลดไว้แล้ว, buffer = ArrayBuffer ของไฟล์ .xlsx
  FBL.importWorkbook = async function (XLSXlib, buffer, progress) {
    requirePrivileged();
    const wb = XLSXlib.read(buffer, { type: 'array' });
    function rows(name) {
      const ws = wb.Sheets[name];
      if (!ws) return null;
      return XLSXlib.utils.sheet_to_json(ws, { defval: '', raw: true });
    }
    const report = [];
    const zones = rows('zones');
    const routes = rows('routes');
    if (!zones && !routes) throw new Error('ไม่พบแท็บ "zones" หรือ "routes" ในไฟล์ — ตรวจสอบว่าเลือกไฟล์ถูกต้อง (เช่น zones-import.xlsx)');
    if (routes) {
      const w = routes.filter(function (r) { return String(r.highway || '').trim() !== ''; }).map(function (r) {
        const d = mapRoute(r); return { ref: db.collection('routes').doc(d.highway), data: d, merge: true };
      });
      await commitInChunks(w, progress, 'สายทาง');
      report.push('สายทาง ' + w.length + ' รายการ');
    }
    if (zones) {
      const w = zones.filter(function (r) { return String(r.id || '').trim() !== ''; }).map(function (r) {
        const d = mapZone(r); return { ref: db.collection('zones').doc(d.id), data: d };
      });
      await commitInChunks(w, progress, 'เขตพื้นที่รับผิดชอบ');
      report.push('เขตพื้นที่รับผิดชอบ ' + w.length + ' รายการ');
    }
    return report;
  };
})();
