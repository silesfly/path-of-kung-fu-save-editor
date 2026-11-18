(function () {
  'use strict';

  const C = window.PokfCodec;
  const D = window.PokfCatalogData || {};
  const K = window.PokfCore;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'className') n.className = props[k];
      else if (k === 'dataset') Object.assign(n.dataset, props[k]);
      else if (k === 'style') n.style.cssText = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') n[k] = props[k];
      else if (props[k] !== undefined) n.setAttribute(k, props[k]);
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach(c => c && n.appendChild(c));
    return n;
  };
  const txt = (t, c) => el(t || 'span', { text: String(c == null ? '' : c) });
  const clear = (n) => n && n.replaceChildren();
  const opt = (v, label, sel) => el('option', { value: String(v), text: label, selected: String(sel) === String(v) });

  const tabNames = ['기본·재화', '능력·전투', '특성·경맥', '무학·심결', '소지품·장비', '동료·검증'];
  const themeNames = { auto: '테마: 자동', light: '테마: 밝게', dark: '테마: 어둡게' };
  const state = {
    save: K.createSampleSave(),
    meta: { containerKind: 'save-binary', slotId: '1' },
    activeTab: 0,
    theme: 'auto',
    mode: 'offline',
    csrf: '',
    slots: [],
    noticeTimer: 0,
    searches: { tf: '', acu: '', jl: '', item: '', equip: '', skill: '' }
  };

  function notice(msg) {
    const bar = $('notice-bar');
    if (!bar) return;
    bar.textContent = msg || '';
    clearTimeout(state.noticeTimer);
    if (msg) state.noticeTimer = setTimeout(() => { bar.textContent = ''; }, 5000);
  }

  function setTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    const b = $('btn-theme');
    if (b) b.textContent = themeNames[t] || themeNames.auto;
  }

  function cycleTheme() {
    setTheme(state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto');
  }

  function currentSlotRaw() {
    const s = $('slot-select');
    return (s && s.value) || (state.slots[0] && (state.slots[0].name || state.slots[0].id)) || '1';
  }

  function currentSlotId() {
    const raw = String(currentSlotRaw());
    const m = raw.match(/PlayerData_(.+)\.save$/i);
    return m ? m[1] : raw;
  }

  function currentSlotName() {
    const raw = String(currentSlotRaw());
    return raw.endsWith('.save') ? raw : ('PlayerData_' + raw + '.save');
  }

  function bindInput(id, obj, key, kind) {
    const n = $(id);
    if (!n) return;
    n.value = obj && obj[key] != null ? String(obj[key]) : '';
    n.addEventListener('input', () => {
      const v = kind === 'number' ? (Number(n.value) || 0) : n.value;
      if (obj) obj[key] = v;
    });
  }

  function field(label, id, type, kind) {
    return el('label', { className: 'field' }, [
      txt('span', label),
      el('input', { id, type: type || 'text', inputmode: kind === 'number' ? 'numeric' : undefined })
    ]);
  }

  function selectField(label, id, options, value) {
    const s = el('select', { id });
    (options || []).forEach(o => s.appendChild(opt(o.id != null ? o.id : o, o.name != null ? o.name : String(o), value)));
    return el('label', { className: 'field' }, [txt('span', label), s]);
  }

  function grid(children, cls) {
    return el('div', { className: cls || 'grid' }, children);
  }

  function button(label, onClick, cls) {
    return el('button', { type: 'button', className: cls || '', text: label, onclick: onClick });
  }

  function tabButton(i, title) {
    return el('button', {
      type: 'button',
      role: 'tab',
      id: 'tab-btn-' + i,
      className: 'tab-btn' + (i === state.activeTab ? ' active' : ''),
      'aria-controls': 'tab-panel-' + i,
      'aria-selected': i === state.activeTab ? 'true' : 'false',
      tabindex: i === state.activeTab ? '0' : '-1',
      text: title,
      onclick: () => selectTab(i)
    });
  }

  function selectTab(i) {
    if (i < 0) i = 5;
    if (i > 5) i = 0;
    state.activeTab = i;
    for (let j = 0; j < 6; j++) {
      const b = $('tab-btn-' + j);
      const p = $('tab-panel-' + j);
      if (b) {
        b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
        b.className = 'tab-btn' + (j === i ? ' active' : '');
      }
      if (p) p.hidden = j !== i;
    }
    if (state.activeTab === 5) {
      const p5 = $('tab-panel-5');
      if (p5) { clear(p5); renderPartners(p5); p5.hidden = false; }
    }
  }

  function tabKey(e) {
    let i = state.activeTab;
    if (e.key === 'ArrowRight') i = (i + 1) % 6;
    else if (e.key === 'ArrowLeft') i = (i + 5) % 6;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = 5;
    else return;
    e.preventDefault();
    selectTab(i);
    const b = $('tab-btn-' + i);
    if (b) b.focus();
  }

  function buildTabs() {
    const list = $('tab-list');
    const panels = $('tab-panels');
    if (!list || !panels) return;
    list.setAttribute('role', 'tablist');
    list.tabIndex = -1;
    list.addEventListener('keydown', tabKey);
    clear(list); clear(panels);
    for (let i = 0; i < 6; i++) {
      const b = tabButton(i, tabNames[i]);
      list.appendChild(b);
      const p = el('section', {
        id: 'tab-panel-' + i,
        role: 'tabpanel',
        'aria-labelledby': 'tab-btn-' + i,
        className: 'tab-panel',
        hidden: i !== state.activeTab
      });
      panels.appendChild(p);
    }
    renderPanels();
  }

  function renderPanels() {
    for (let i = 0; i < 6; i++) {
      const p = $('tab-panel-' + i);
      if (!p) continue;
      clear(p);
      if (i === 0) renderBasic(p);
      if (i === 1) renderCombat(p);
      if (i === 2) renderTraits(p);
      if (i === 3) renderSkills(p);
      if (i === 4) renderItems(p);
      if (i === 5) renderPartners(p);
      p.hidden = i !== state.activeTab;
    }
  }

  function saveObj() { return state.save || (state.save = K.createSampleSave()); }

  function renderBasic(p) {
    const s = saveObj();
    const wrap = el('div', { className: 'form' });
    wrap.appendChild(el('h2', { text: '기본 정보' }));
    wrap.appendChild(grid([
      field('이름', 'firstName'), field('성', 'lastName'),
      field('은자', 'sliver', 'number', 'number'), field('금자', 'gold', 'number', 'number'),
      field('문파 공헌', 'sectcoin', 'number', 'number'), field('무맹 공헌', 'gangCoin', 'number', 'number'),
      field('수위(수련치)', 'xiuWei', 'number', 'number'), field('열력', 'YueLi', 'number', 'number'),
      field('경험치', 'JingYan', 'number', 'number'), field('기력', 'SP', 'number', 'number'),
      field('체력(HP)', 'HP', 'number', 'number'), field('포만감', 'baoShi', 'number', 'number'),
      field('대세계 체력', 'BigWorldStrength', 'number', 'number'), field('잔여 속성점', 'surplusAttributeNum', 'number', 'number'),
      field('체포 횟수', 'ArrestNum', 'number', 'number')
    ]));
    const realms = (D.realms || K.REALM_NAMES || []).map((r, i) => ({ id: i + 1, name: String(r) }));
    const diffs = (D.difficulties || []).map(d => ({ id: d.id, name: d.name }));
    const parties = [{ id: 0, name: '무소속' }].concat(
      (D.parties || []).map(x => ({ id: x.id != null ? x.id : x, name: x.name != null ? x.name : String(x) }))
    );
    wrap.appendChild(grid([
      selectField('경지', 'attribute', realms, s.attribute != null ? s.attribute : 1),
      selectField('난이도', 'gameLv', diffs, s.gameLv != null ? s.gameLv : 0),
      selectField('문파', 'sect', parties, s.sect != null ? s.sect : 0),
      field('문파 지위', 'sectLv', 'number', 'number'),
      field('무맹 소속', 'gang', 'number', 'number'),
      field('무맹 등급', 'gangLv', 'number', 'number')
    ]));
    p.appendChild(wrap);
    bindInput('firstName', s, 'firstName'); bindInput('lastName', s, 'lastName');
    bindInput('sliver', s, 'sliver', 'number'); bindInput('gold', s, 'gold', 'number');
    bindInput('sectcoin', s, 'sectcoin', 'number'); bindInput('gangCoin', s, 'gangCoin', 'number');
    bindInput('xiuWei', s, 'xiuWei', 'number'); bindInput('YueLi', s, 'YueLi', 'number');
    bindInput('JingYan', s, 'JingYan', 'number'); bindInput('SP', s, 'SP', 'number');
    bindInput('HP', s, 'HP', 'number'); bindInput('baoShi', s, 'baoShi', 'number');
    bindInput('BigWorldStrength', s, 'BigWorldStrength', 'number');
    bindInput('surplusAttributeNum', s, 'surplusAttributeNum', 'number');
    bindInput('ArrestNum', s, 'ArrestNum', 'number');
    bindInput('sectLv', s, 'sectLv', 'number');
    bindInput('gang', s, 'gang', 'number');
    bindInput('gangLv', s, 'gangLv', 'number');
    ['attribute', 'gameLv', 'sect'].forEach(k => {
      const n = $(k); if (!n) return;
      n.value = s[k] == null ? (k === 'attribute' ? '1' : '0') : String(s[k]);
      n.addEventListener('change', () => { s[k] = Number(n.value) || 0; });
    });
  }

  function renderCombat(p) {
    const s = saveObj();
    if (!s.roleAttribute || typeof s.roleAttribute !== 'object') s.roleAttribute = {};
    const ra = s.roleAttribute;
    const attrs = [
      ['Wl', '무력'], ['Sf', '신법'], ['Jg', '근골'], ['Nx', '내식'], ['Wx', '오성']
    ];
    const keys = [
      ['Start', '초기'], ['Other', '보정'], ['AllTime', '누적']
    ];
    p.appendChild(el('h2', { text: '능력·전투' }));
    const g = grid([], 'grid combat-grid');
    attrs.forEach(([a, aname]) => keys.forEach(([k, kname]) => {
      const id = 'attribute' + a + '_' + k;
      const cid = 'combat_' + id;
      g.appendChild(field(aname + ' (' + kname + ')', cid, 'number', 'number'));
      if (s[id] == null) s[id] = 0;
    }));
    p.appendChild(g);
    attrs.forEach(([a]) => keys.forEach(([k]) => {
      const id = 'attribute' + a + '_' + k;
      bindInput('combat_' + id, s, id, 'number');
    }));

    const roleFields = [
      ['attributeWl', '무력(실전)'], ['attributeSf', '신법(실전)'], ['attributeJg', '근골(실전)'],
      ['attributeNx', '내식(실전)'], ['attributeWx', '오성(실전)'],
      ['attack', '외공 공격'], ['attackNei', '내공 공격'], ['defensive', '외공 방어'], ['defensiveNei', '내공 방어'],
      ['move', '이동력'], ['hit', '명중'], ['dodge', '회피'],
      ['blood', '기혈'], ['bloodRecovery', '기혈 회복'], ['strength', '체력'], ['strengthRecovery', '체력 회복'],
      ['zhenQ', '진기'], ['zhenQSx', '진기 상한'], ['baoJ', '치명타'], ['mBaoJ', '치명 배율'],
      ['xiXue', '흡혈'], ['fanShang', '반사']
    ];
    const rg = grid([], 'grid role-grid');
    roleFields.forEach(([id, label]) => {
      rg.appendChild(field(label, 'role_' + id, 'number', 'number'));
      if (ra[id] == null) ra[id] = 0;
    });
    p.appendChild(rg);
    roleFields.forEach(([id]) => bindInput('role_' + id, ra, id, 'number'));

    p.appendChild(grid([
      button('전투 능력치 상향', () => {
        roleFields.forEach(([id]) => { ra[id] = Math.max(Number(ra[id]) || 0, 999); });
        renderPanels(); notice('전투 능력치를 상향했습니다.');
      }),
      button('근본 능력치 초기화', () => {
        attrs.forEach(([a]) => keys.forEach(([k]) => { s['attribute' + a + '_' + k] = 0; }));
        renderPanels(); notice('근본 능력치를 초기화했습니다.');
      })
    ]));
  }

  function toggleList(container, source, arr, labelFn, search, cap) {
    clear(container);
    const q = (search || '').trim().toLowerCase();
    let count = 0;
    (source || []).forEach((item, idx) => {
      const id = Number(item.id != null ? item.id : idx);
      const name = labelFn ? labelFn(item) : String(item.name != null ? item.name : id);
      if (q && !name.toLowerCase().includes(q) && !String(id).toLowerCase().includes(q)) return;
      if (count >= cap) return;
      count++;
      const cb = el('input', { type: 'checkbox' });
      cb.checked = Array.isArray(arr) && arr.map(Number).includes(id);
      cb.addEventListener('change', () => {
        if (!Array.isArray(arr)) return;
        const i = arr.map(Number).indexOf(id);
        if (cb.checked && i === -1) arr.push(id);
        if (!cb.checked && i !== -1) arr.splice(i, 1);
      });
      container.appendChild(el('label', { className: 'toggle-row' }, [cb, txt('span', name + ' (' + id + ')')]));
    });
  }

  function renderTraits(p) {
    const s = saveObj();
    s.m_myTfList = Array.isArray(s.m_myTfList) ? s.m_myTfList : [];
    s.acupointDataList = Array.isArray(s.acupointDataList) ? s.acupointDataList : [];
    s.acupointJlDataList = Array.isArray(s.acupointJlDataList) ? s.acupointJlDataList : [];
    p.appendChild(el('h2', { text: '특성·경맥' }));
    const mk = (title, src, key, searchKey, cap) => {
      const box = el('div', { className: 'card' });
      box.appendChild(el('h3', { text: title }));
      const inp = el('input', { type: 'search', placeholder: '검색', value: state.searches[searchKey] || '' });
      const list = el('div', { className: 'list' });
      inp.addEventListener('input', () => {
        state.searches[searchKey] = inp.value;
        toggleList(list, src, s[key], x => x.name != null ? x.name : String(x), state.searches[searchKey], cap || 100);
      });
      box.appendChild(inp);
      box.appendChild(list);
      toggleList(list, src, s[key], x => x.name != null ? x.name : String(x), state.searches[searchKey], cap || 100);
      return box;
    };
    p.appendChild(grid([
      mk('선천 특성', D.inborn || [], 'm_myTfList', 'tf'),
      mk('경혈', D.acupoints || [], 'acupointDataList', 'acu'),
      mk('경락', D.collaterals || [], 'acupointJlDataList', 'jl')
    ]));
    p.appendChild(button('모든 경맥 개방', () => {
      if (K.unlockAllMeridians) K.unlockAllMeridians(s, D);
      renderPanels(); notice('모든 경맥을 개방했습니다.');
    }, 'primary'));
  }

  function renderSkills(p) {
    const s = saveObj();
    s.m_allSkillList = (s.m_allSkillList && !Array.isArray(s.m_allSkillList)) ? s.m_allSkillList : {};
    s.m_allXinJue = Array.isArray(s.m_allXinJue) ? s.m_allXinJue : [];
    s.listMySorcery = Array.isArray(s.listMySorcery) ? s.listMySorcery : [];
    s.m_allMinJuan = Array.isArray(s.m_allMinJuan) ? s.m_allMinJuan : [];
    p.appendChild(el('h2', { text: '무학·심결' }));

    const gbox = el('div', { className: 'card' });
    gbox.appendChild(el('h3', { text: '무학' }));
    (D.martialGroups || []).slice(0, 100).forEach(g => {
      const key = String(g.id);
      const has = !!s.m_allSkillList[key];
      const skillIds = (g.skills || []).flatMap(x => String(x).split(';')).filter(Boolean);
      gbox.appendChild(el('label', { className: 'toggle-row' }, [
        el('input', {
          type: 'checkbox', checked: has, onchange: (e) => {
            if (e.target.checked) K.addWuxue(s, g.id, skillIds);
            else K.removeWuxue(s, g.id);
          }
        }),
        txt('span', (g.name || key) + ' (' + key + ')')
      ]));
    });

    const x = el('div', { className: 'card' });
    x.appendChild(el('h3', { text: '심결' }));
    const xList = el('div', { className: 'list' });
    toggleList(xList, D.xinjue || [], s.m_allXinJue, it => it.name || String(it.id), '', 120);
    x.appendChild(xList);

    const sor = el('div', { className: 'card' });
    sor.appendChild(el('h3', { text: '술법' }));
    (D.sorceries || []).slice(0, 100).forEach((it, i) => {
      const id = Number(it.id != null ? it.id : i);
      const cur = s.listMySorcery.find(z => Number(z.id) === id);
      sor.appendChild(el('label', { className: 'toggle-row' }, [
        el('input', {
          type: 'checkbox', checked: !!cur, onchange: e => {
            if (e.target.checked) K.upsertSorcery(s, id, 1);
            else K.removeSorcery(s, id);
          }
        }),
        txt('span', (it.name || String(id)) + ' (' + id + ')')
      ]));
    });

    const mj = el('div', { className: 'card' });
    mj.appendChild(el('h3', { text: '비전' }));
    const mjList = el('div', { className: 'list' });
    toggleList(mjList, D.mijuan || [], s.m_allMinJuan, it => it.name || String(it.id), '', 100);
    mj.appendChild(mjList);

    p.appendChild(grid([gbox, x, sor, mj]));
  }

  function itemName(id) {
    const it = (D.items || []).find(x => (x.id != null ? x.id : x.itemId) == id);
    return it ? (it.name || String(id)) : String(id);
  }

  function renderItems(p) {
    const s = saveObj();
    s.listMyItemData = Array.isArray(s.listMyItemData) ? s.listMyItemData : [];
    s.listMyEuipData = Array.isArray(s.listMyEuipData) ? s.listMyEuipData : [];
    p.appendChild(el('h2', { text: '소지품·장비' }));

    const ibox = el('div', { className: 'card' });
    ibox.appendChild(el('h3', { text: '소지품 (' + s.listMyItemData.length + ')' }));
    const iq = el('input', { type: 'search', placeholder: '아이템 검색', value: state.searches.item || '' });
    iq.addEventListener('input', () => { state.searches.item = iq.value; renderPanels(); });
    ibox.appendChild(iq);
    const ilist = el('div', { className: 'list' });
    s.listMyItemData.forEach((it, idx) => {
      const nm = itemName(it.itemId);
      const q = (state.searches.item || '').trim().toLowerCase();
      if (q && !nm.toLowerCase().includes(q) && !String(it.itemId).includes(q)) return;
      ilist.appendChild(el('div', { className: 'row' }, [
        txt('span', nm + ' (' + it.itemId + ')'),
        el('input', { type: 'number', value: it.count || 0, onchange: e => { it.count = Number(e.target.value) || 0; } }),
        button('삭제', () => { s.listMyItemData.splice(idx, 1); renderPanels(); })
      ]));
    });
    ibox.appendChild(ilist);
    const addItem = el('div', { className: 'row' });
    const iSel = el('select', {});
    const qItem = (state.searches.item || '').trim().toLowerCase();
    (D.items || []).filter(it => !qItem || (it.name || '').toLowerCase().includes(qItem) || String(it.id).includes(qItem)).slice(0, 80)
      .forEach(it => iSel.appendChild(opt(it.id, (it.name || String(it.id)) + ' (' + it.id + ')')));
    addItem.appendChild(iSel);
    addItem.appendChild(button('추가', () => {
      if (!iSel.value) return;
      K.upsertItem(s, Number(iSel.value), 1, true);
      renderPanels(); notice('아이템을 추가했습니다.');
    }));
    ibox.appendChild(addItem);
    p.appendChild(ibox);

    const ebox = el('div', { className: 'card' });
    ebox.appendChild(el('h3', { text: '장비 (' + s.listMyEuipData.length + ')' }));
    const eq = el('input', { type: 'search', placeholder: '장비 검색', value: state.searches.equip || '' });
    eq.addEventListener('input', () => { state.searches.equip = eq.value; renderPanels(); });
    ebox.appendChild(eq);
    const elist = el('div', { className: 'list' });
    s.listMyEuipData.forEach((it, idx) => {
      const nm = itemName(it.quipId);
      const q = (state.searches.equip || '').trim().toLowerCase();
      if (q && !nm.toLowerCase().includes(q) && !String(it.quipId).includes(q)) return;
      elist.appendChild(el('div', { className: 'row' }, [
        txt('span', nm + ' (' + it.quipId + ')'),
        el('input', { type: 'number', value: it.quality || 0, onchange: e => { it.quality = Number(e.target.value) || 0; } }),
        el('label', { className: 'toggle-row' }, [
          el('input', { type: 'checkbox', checked: Number(it.IsLock) === 1, onchange: e => { it.IsLock = e.target.checked ? 1 : 0; } }),
          txt('span', '잠금')
        ]),
        button('삭제', () => { s.listMyEuipData.splice(idx, 1); renderPanels(); })
      ]));
    });
    ebox.appendChild(elist);
    const addEq = el('div', { className: 'row' });
    const eSel = el('select', {});
    const qEq = (state.searches.equip || '').trim().toLowerCase();
    (D.items || []).filter(it => it.bucket === 'equip' && (!qEq || (it.name || '').toLowerCase().includes(qEq) || String(it.id).includes(qEq))).slice(0, 80)
      .forEach(it => eSel.appendChild(opt(it.id, (it.name || String(it.id)) + ' (' + it.id + ')')));
    addEq.appendChild(eSel);
    addEq.appendChild(button('추가', () => {
      if (!eSel.value) return;
      K.addEquip(s, Number(eSel.value), { quality: 1, IsLock: 0 });
      renderPanels(); notice('장비를 추가했습니다.');
    }));
    ebox.appendChild(addEq);
    p.appendChild(ebox);
  }

  function renderPartners(p) {
    const s = saveObj();
    s.listPartnerAttribute = Array.isArray(s.listPartnerAttribute) ? s.listPartnerAttribute : [];
    p.appendChild(el('h2', { text: '동료·검증' }));
    const box = el('div', { className: 'card' });
    box.appendChild(el('h3', { text: '동료 (' + s.listPartnerAttribute.length + ')' }));
    s.listPartnerAttribute.forEach((pa, i) => {
      box.appendChild(el('div', { className: 'row' }, [
        txt('span', (pa.name || '동료 ' + (i + 1)) + ' · HP ' + (pa.blood || 0)),
        el('input', { type: 'number', value: pa.blood || 0, onchange: e => { pa.blood = Number(e.target.value) || 0; } })
      ]));
    });
    if (!s.listPartnerAttribute.length) {
      box.appendChild(txt('p', '등록된 동료 데이터가 없습니다.'));
    }
    p.appendChild(box);

    const rep = el('div', { className: 'card' });
    rep.appendChild(el('h3', { text: '검증 결과' }));
    let res = { ok: true, issues: [] };
    try { res = K.validateSave ? K.validateSave(s) : { ok: true, issues: [] }; }
    catch (e) { res = { ok: false, issues: ['검증 오류: ' + e.message] }; }
    const issues = Array.isArray(res && res.issues) ? res.issues : (Array.isArray(res) ? res : []);
    if (!issues.length) rep.appendChild(txt('p', '이상 없음'));
    else issues.slice(0, 50).forEach(m => rep.appendChild(txt('p', String(m))));
    p.appendChild(rep);

    p.appendChild(grid([
      button('JSON 미리보기', () => showModal('JSON 미리보기', () => {
        const pre = el('pre', { className: 'json-preview' });
        pre.textContent = JSON.stringify(s, null, 2).slice(0, 20000);
        return pre;
      }), 'primary'),
      button('검증 새로고침', () => { renderPanels(); notice('검증을 갱신했습니다.'); })
    ]));
  }

  function showModal(title, contentFn) {
    const dlg = $('modal-dialog');
    const t = $('modal-title');
    const body = $('modal-body');
    if (!dlg || !t || !body) return;
    t.textContent = title;
    clear(body);
    const c = contentFn && contentFn();
    if (c) body.appendChild(c);
    if (typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    else dlg.setAttribute('open', '');
  }

  function closeModal() {
    const dlg = $('modal-dialog');
    if (!dlg) return;
    if (typeof dlg.close === 'function') { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } }
    else dlg.removeAttribute('open');
  }

  function renderPresets() {
    const bar = $('preset-bar');
    if (!bar) return;
    clear(bar);
    (K.PRESETS || []).forEach(p => {
      bar.appendChild(el('button', {
        type: 'button', className: 'preset-btn', dataset: { preset: p.id }, text: p.name || p.id,
        onclick: () => {
          if (K.applyPreset) K.applyPreset(state.save, p.id, D);
          renderPanels(); notice('프리셋 적용: ' + (p.name || p.id));
        }
      }));
    });
  }

  function applyLoadedPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const root = payload.root || payload.data || payload.save;
    if (root && typeof root === 'object') {
      state.save = root;
      state.meta = payload.meta || {
        containerKind: 'save-binary',
        slotId: payload.slotId || currentSlotId(),
        saveKey: payload.key || ''
      };
      return true;
    }
    return false;
  }

  function download(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function openOffline(file) {
    try {
      const buf = await file.arrayBuffer();
      const decoded = await C.decodeSaveBytes(new Uint8Array(buf), { fileName: file.name });
      if (!applyLoadedPayload(decoded)) {
        state.save = decoded || K.createSampleSave();
        state.meta = { containerKind: 'save-binary', slotId: currentSlotId() };
      }
      renderPanels(); notice('파일을 불러왔습니다: ' + file.name);
    } catch (e) { notice('불러오기 실패: ' + (e && e.message ? e.message : e)); }
  }

  async function saveOffline() {
    try {
      const check = K.validateSave(state.save);
      if (!check.ok) { notice('저장 검증 실패: ' + check.errors.join(', ')); return; }
      const data = await C.encodeSaveBytes(state.save, {
        containerKind: 'save-binary',
        slotId: currentSlotId(),
        saveKey: state.meta && state.meta.saveKey
      });
      download('PlayerData_' + currentSlotId() + '.save', data);
      notice('저장 파일을 내려받았습니다.');
    } catch (e) { notice('저장 실패: ' + (e && e.message ? e.message : e)); }
  }

  async function detectMode() {
    if (window.chrome && window.chrome.webview) { state.mode = 'webview2'; return; }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const r = await fetch('/api/session', { credentials: 'same-origin' });
        if (r && r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j && j.ok) {
            state.mode = 'http';
            state.csrf = j.token || j.csrf || '';
            return;
          }
        }
      } catch (e) {}
    }
    state.mode = 'offline';
  }

  function updateBadge() {
    const b = $('conn-badge');
    if (!b) return;
    b.textContent = state.mode === 'http' ? '서버 연결됨' : state.mode === 'webview2' ? '네이티브 연결됨' : '오프라인 파일 모드';
  }

  async function api(path, opts) {
    const o = Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {});
    if (state.csrf) o.headers['X-Pokf-Token'] = state.csrf;
    const r = await fetch(path, o);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) throw new Error(body.msg || body.error || ('HTTP ' + r.status));
    return body;
  }

  function populateSlotSelect(slots) {
    state.slots = Array.isArray(slots) ? slots : [];
    const sel = $('slot-select');
    if (!sel || !state.slots.length) return;
    clear(sel);
    state.slots.forEach(s => {
      const name = typeof s === 'string' ? s : (s.name || s.id || '');
      if (name) sel.appendChild(opt(name, name));
    });
  }

  async function initHttp() {
    try {
      const res = await api('/api/slots');
      populateSlotSelect(res.slots || []);
      if (state.slots.length) {
        const name = state.slots[0].name || state.slots[0];
        const loaded = await api('/api/load', { method: 'POST', body: JSON.stringify({ name }) });
        applyLoadedPayload(loaded);
        renderPanels();
      } else {
        state.save = K.createSampleSave(); renderPanels();
      }
      notice('서버에 연결되었습니다.');
    } catch (e) { notice('서버 로드 실패: ' + (e && e.message ? e.message : e)); }
  }

  async function saveHttp() {
    try {
      const check = K.validateSave(state.save);
      if (!check.ok) { notice('저장 검증 실패: ' + check.errors.join(', ')); return; }
      await api('/api/save', {
        method: 'POST',
        body: JSON.stringify({ name: currentSlotName(), key: state.meta && state.meta.saveKey, data: state.save })
      });
      notice('서버에 저장했습니다.');
    } catch (e) { notice('서버 저장 실패: ' + (e && e.message ? e.message : e)); }
  }

  function renderBackupList(files, restoreFn) {
    const box = el('div', { className: 'list' });
    const list = (files || []).filter(f => {
      const nm = typeof f === 'string' ? f : (f && f.name);
      return nm && String(nm).endsWith('.bak');
    });
    if (!list.length) {
      box.appendChild(txt('p', '생성된 백업 파일이 없습니다.'));
      return box;
    }
    list.forEach(f => {
      const nm = typeof f === 'string' ? f : f.name;
      box.appendChild(el('div', { className: 'row' }, [
        txt('span', nm),
        button('복원', async () => restoreFn(nm))
      ]));
    });
    return box;
  }

  async function showBackupsHttp() {
    try {
      const res = await api('/api/backups');
      const files = res.backups || res.files || [];
      showModal('백업 목록', () => renderBackupList(files, async (bname) => {
        try {
          await api('/api/restore', { method: 'POST', body: JSON.stringify({ name: currentSlotName(), backup: bname }) });
          const reloaded = await api('/api/load', { method: 'POST', body: JSON.stringify({ name: currentSlotName() }) }).catch(() => null);
          if (reloaded) { applyLoadedPayload(reloaded); renderPanels(); }
          closeModal(); notice('백업을 복원했습니다: ' + bname);
        } catch (e) { notice('복원 실패: ' + e.message); }
      }));
    } catch (e) { notice('백업 목록 실패: ' + e.message); }
  }

  let rpcId = 1;
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage)) return reject(new Error('웹뷰 없음'));
      const id = rpcId++;
      const handler = (e) => {
        let d = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
        if (!d || d.id !== id) return;
        window.chrome.webview.removeEventListener('message', handler);
        if (d.ok === false || d.error) reject(new Error((d.error && d.error.message) || d.error || d.msg || '요청 실패'));
        else resolve(d.result != null ? d.result : d);
      };
      window.chrome.webview.addEventListener('message', handler);
      window.chrome.webview.postMessage(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async function initWebview() {
    try {
      const res = await rpc('list_slots', {});
      populateSlotSelect(Array.isArray(res) ? res : (res.slots || []));
      if (state.slots.length) {
        const name = state.slots[0].name || state.slots[0];
        const loaded = await rpc('load_slot', { name });
        applyLoadedPayload(loaded);
        renderPanels();
      } else { state.save = K.createSampleSave(); renderPanels(); }
      notice('데스크톱 환경에 연결되었습니다.');
    } catch (e) { notice('네이티브 로드 실패: ' + (e && e.message ? e.message : e)); }
  }

  async function saveWebview() {
    try {
      const check = K.validateSave(state.save);
      if (!check.ok) { notice('저장 검증 실패: ' + check.errors.join(', ')); return; }
      await rpc('save_slot', { name: currentSlotName(), key: state.meta && state.meta.saveKey, data: state.save });
      notice('저장했습니다 (자동 백업 완료).');
    } catch (e) { notice('저장 실패: ' + (e && e.message ? e.message : e)); }
  }

  async function showBackupsWebview() {
    try {
      const res = await rpc('list_backups', { name: currentSlotName() });
      const files = Array.isArray(res) ? res : (res.backups || res.files || []);
      showModal('백업 목록', () => renderBackupList(files, async (bname) => {
        try {
          await rpc('restore_backup', { name: currentSlotName(), backup: bname });
          const reloaded = await rpc('load_slot', { name: currentSlotName() }).catch(() => null);
          if (reloaded) { applyLoadedPayload(reloaded); renderPanels(); }
          closeModal(); notice('백업을 복원했습니다: ' + bname);
        } catch (e) { notice('복원 실패: ' + e.message); }
      }));
    } catch (e) { notice('백업 목록 실패: ' + e.message); }
  }

  function wire() {
    const th = $('btn-theme'); if (th) th.addEventListener('click', cycleTheme);
    const fi = $('file-input'); if (fi) fi.addEventListener('change', () => { if (fi.files && fi.files[0]) openOffline(fi.files[0]); fi.value = ''; });
    const of = $('btn-open-file'); if (of) of.addEventListener('click', () => fi && fi.click());
    const demo = $('btn-demo'); if (demo) demo.addEventListener('click', () => {
      state.save = K.createSampleSave();
      state.meta = { containerKind: 'save-binary', slotId: currentSlotId() };
      renderPanels(); notice('샘플 데이터를 불러왔습니다.');
    });
    const sv = $('btn-save'); if (sv) sv.addEventListener('click', () => {
      if (state.mode === 'http') saveHttp();
      else if (state.mode === 'webview2') saveWebview();
      else saveOffline();
    });
    const bk = $('btn-backup'); if (bk) bk.addEventListener('click', () => {
      if (state.mode === 'http') showBackupsHttp();
      else if (state.mode === 'webview2') showBackupsWebview();
      else showModal('백업 안내', () => txt('p', '오프라인 파일 모드에서는 파일 저장 시 브라우저 다운로드 폴더에 새 파일로 저장됩니다. 자동 백업 및 복원은 서버 또는 데스크톱 모드에서 사용할 수 있습니다.'));
    });
    const mc = $('modal-close'); if (mc) mc.addEventListener('click', closeModal);
    const dlg = $('modal-dialog'); if (dlg) dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); });
    const sel = $('slot-select'); if (sel) sel.addEventListener('change', async () => {
      if (state.mode === 'http') {
        try {
          const r = await api('/api/load', { method: 'POST', body: JSON.stringify({ name: currentSlotName() }) });
          if (applyLoadedPayload(r)) renderPanels();
        } catch (e) { notice(e.message); }
      } else if (state.mode === 'webview2') {
        try {
          const r = await rpc('load_slot', { name: currentSlotName() });
          if (applyLoadedPayload(r)) renderPanels();
        } catch (e) { notice(e.message); }
      }
    });
  }

  async function init() {
    setTheme(state.theme);
    buildTabs();
    renderPresets();
    wire();
    await detectMode();
    updateBadge();
    if (state.mode === 'http') await initHttp();
    else if (state.mode === 'webview2') await initWebview();
    else notice('오프라인 파일 모드입니다. 세이브 파일(.save)을 열거나 샘플 데이터를 불러오세요.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
