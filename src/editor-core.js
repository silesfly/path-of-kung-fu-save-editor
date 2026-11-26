(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PokfCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REALM_NAMES = ['조통피모', '단근축골', '내외겸수', '기혈관통', '삼화취정', '오기관통', '임독이맥', '일대종사', '등봉조극', '반박귀진'];
  var DIFFICULTY_NAMES = ['보통', '어려움', '극난'];
  var EQUIP_SLOTS = [
    { id: 0, name: '무기' },
    { id: 1, name: '머리' },
    { id: 2, name: '의복' },
    { id: 3, name: '장갑' },
    { id: 4, name: '신발' },
    { id: 5, name: '장신구' },
    { id: 6, name: '패식' }
  ];

  var ATTRIBUTE_PREFIXES = ['Wl', 'Sf', 'Jg', 'Nx', 'Wx'];
  var ATTRIBUTE_SUFFIXES = ['Start', 'Other', 'AllTime'];

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';
  }

  function toNumber(value) {
    var n = Number(value);
    return isFinite(n) ? n : NaN;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isInteger(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function uniqueNumberList(list) {
    var seen = {};
    var result = [];
    for (var i = 0; i < list.length; i++) {
      var n = Number(list[i]);
      if (isFinite(n) && !seen[n]) {
        seen[n] = true;
        result.push(n);
      }
    }
    return result;
  }

  function ensureArray(root, key) {
    if (!Array.isArray(root[key])) {
      root[key] = [];
    }
    return root[key];
  }

  function ensureObject(root, key) {
    if (!isPlainObject(root[key])) {
      root[key] = {};
    }
    return root[key];
  }

  function makeGuid(prefix, id) {
    return prefix + '_' + id + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function assertPlayer(root) {
    if (!isPlainObject(root)) {
      throw new Error('플레이어 데이터는 배열이 아닌 객체여야 합니다.');
    }
    if (root.PlayerData && !root.firstName && !root.lastName && !root.sliver && !root.gold) {
      throw new Error('플레이어 데이터가 래퍼 객체로 감싸져 있습니다. 루트 객체를 사용하세요.');
    }
    return root;
  }

  function createRoleAttribute() {
    return {
      attributeWl: 10,
      attributeSf: 10,
      attributeJg: 10,
      attributeNx: 10,
      attributeWx: 10,
      attack: 20,
      attackNei: 20,
      move: 10,
      hit: 10,
      dodge: 10,
      defensive: 10,
      defensiveNei: 10,
      blood: 100,
      bloodRecovery: 1,
      strength: 100,
      strengthRecovery: 1,
      zhenQ: 100,
      zhenQSx: 1,
      baoJ: 1,
      mBaoJ: 1,
      xiXue: 1,
      fanShang: 1
    };
  }

  function createSampleSave() {
    var rootAttr = {};
    var i;
    var j;
    for (i = 0; i < ATTRIBUTE_PREFIXES.length; i++) {
      for (j = 0; j < ATTRIBUTE_SUFFIXES.length; j++) {
        rootAttr['attribute' + ATTRIBUTE_PREFIXES[i] + '_' + ATTRIBUTE_SUFFIXES[j]] = 0;
      }
    }

    var sample = {
      firstName: '이름',
      lastName: '무명',
      attribute: 1,
      lichang: 0,
      gameLv: 0,
      gameTime: 0,
      saveTime: 0,
      isSandBoxMode: 0,
      surplusAttributeNum: 0,
      ArrestNum: 0,

      sliver: 1000,
      gold: 100,
      sectcoin: 0,
      gangCoin: 0,
      xiuWei: 0,
      YueLi: 0,
      JingYan: 0,
      SP: 0,
      BigWorldStrength: 0,
      HP: 100,
      baoShi: 0,

      roleAttribute: createRoleAttribute(),

      m_myTfList: [],
      acupointDataList: [],
      acupointJlDataList: [],
      m_allSkillList: { '101000': ['1010001'] },
      m_allXinJue: [],
      listMySorcery: [],
      m_allMinJuan: [],
      listMyItemData: [
        { _guid: 'item_1', itemId: 901000, count: 3 }
      ],
      listMyEuipData: [
        { guid: 'eq_1', quipId: 102001, _quipTypeId: 0, quality: 1, wearId: 0, IsLock: 0 }
      ],
      myEuipList: {
        '0': { guid: 'eq_1', quipId: 102001, _quipTypeId: 0, quality: 1, wearId: 0, IsLock: 0 }
      },
      sect: 0,
      sectLv: 0,
      gang: 0,
      gangLv: 0,
      listPartner: [],
      listPartnerAttribute: []
    };

    for (var key in rootAttr) {
      if (Object.prototype.hasOwnProperty.call(rootAttr, key)) {
        sample[key] = rootAttr[key];
      }
    }

    return cloneDeep(sample);
  }

  function cloneDeep(value) {
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) {
        arr.push(cloneDeep(value[i]));
      }
      return arr;
    }
    if (isPlainObject(value)) {
      var obj = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          obj[key] = cloneDeep(value[key]);
        }
      }
      return obj;
    }
    return value;
  }

  function summarizeSave(root) {
    var data = assertPlayer(root);
    var realmIndex = isIntegerNumber(data.attribute) ? data.attribute : 1;
    var realmName = REALM_NAMES[realmIndex - 1] || REALM_NAMES[0];
    var difficultyName = DIFFICULTY_NAMES[data.gameLv] || DIFFICULTY_NAMES[0];
    var wuxueCount = 0;
    if (isPlainObject(data.m_allSkillList)) {
      for (var groupId in data.m_allSkillList) {
        if (Object.prototype.hasOwnProperty.call(data.m_allSkillList, groupId) && Array.isArray(data.m_allSkillList[groupId])) {
          wuxueCount += data.m_allSkillList[groupId].length;
        }
      }
    }
    var firstName = String(data.firstName == null ? '' : data.firstName);
    var lastName = String(data.lastName == null ? '' : data.lastName);
    return {
      fullName: (lastName + firstName).trim(),
      firstName: firstName,
      lastName: lastName,
      realmIndex: realmIndex,
      realmName: realmName,
      difficultyName: difficultyName,
      sliver: Number(data.sliver) || 0,
      gold: Number(data.gold) || 0,
      xiuWei: Number(data.xiuWei) || 0,
      itemCount: Array.isArray(data.listMyItemData) ? data.listMyItemData.length : 0,
      equipCount: Array.isArray(data.listMyEuipData) ? data.listMyEuipData.length : 0,
      wuxueCount: wuxueCount,
      xinjueCount: Array.isArray(data.m_allXinJue) ? data.m_allXinJue.length : 0,
      acupointCount: Array.isArray(data.acupointDataList) ? data.acupointDataList.length : 0,
      partnerCount: Array.isArray(data.listPartner) ? data.listPartner.length : 0
    };
  }

  function isIntegerNumber(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function validateSave(root) {
    var errors = [];
    var warnings = [];
    if (!isPlainObject(root)) {
      errors.push('저장 데이터가 객체가 아닙니다.');
      return makeValidationResult(errors, warnings);
    }

    var nonNegativeFields = [
      'sliver', 'gold', 'sectcoin', 'gangCoin', 'xiuWei', 'YueLi', 'JingYan', 'SP',
      'ArrestNum', 'surplusAttributeNum'
    ];
    for (var i = 0; i < nonNegativeFields.length; i++) {
      var field = nonNegativeFields[i];
      if (root[field] !== undefined) {
        if (!isFiniteNumber(root[field])) {
          errors.push(field + ' 값이 숫자가 아닙니다.');
        } else if (root[field] < 0) {
          errors.push(field + ' 값은 0 이상이어야 합니다.');
        }
      }
    }

    var warnOnNegativeFields = ['HP', 'baoShi'];
    for (var w = 0; w < warnOnNegativeFields.length; w++) {
      var wField = warnOnNegativeFields[w];
      if (root[wField] !== undefined) {
        if (!isFiniteNumber(root[wField])) {
          errors.push(wField + ' 값이 숫자가 아닙니다.');
        } else if (root[wField] < 0) {
          warnings.push(wField + ' 값이 음수입니다.');
        }
      }
    }

    if (root.attribute !== undefined) {
      if (!isIntegerNumber(root.attribute) || root.attribute < 0 || root.attribute > 50) {
        errors.push('경지 값은 0부터 50 사이의 정수여야 합니다.');
      } else if (root.attribute < 1 || root.attribute > 10) {
        warnings.push('경지 값이 기본 범위(1~10) 밖입니다: ' + root.attribute);
      }
    }

    if (root.gameLv !== undefined) {
      if (!isIntegerNumber(root.gameLv) || root.gameLv < 0 || root.gameLv > 10) {
        errors.push('난이도 값은 0부터 10 사이의 정수여야 합니다.');
      } else if (root.gameLv > 2) {
        warnings.push('난이도 값이 기본 범위(0~2) 밖입니다: ' + root.gameLv);
      }
    }

    var arrayFields = [
      'm_myTfList', 'acupointDataList', 'acupointJlDataList', 'm_allXinJue', 'listMySorcery',
      'listMyItemData', 'listMyEuipData', 'listPartner', 'listPartnerAttribute'
    ];
    for (var a = 0; a < arrayFields.length; a++) {
      var arrayField = arrayFields[a];
      if (root[arrayField] !== undefined && !Array.isArray(root[arrayField])) {
        errors.push(arrayField + ' 값은 배열이어야 합니다.');
      }
    }

    var objectFields = ['m_allSkillList', 'myEuipList', 'roleAttribute'];
    for (var o = 0; o < objectFields.length; o++) {
      var objectField = objectFields[o];
      if (root[objectField] !== undefined && !isPlainObject(root[objectField])) {
        errors.push(objectField + ' 값은 객체여야 합니다.');
      }
    }

    if (root.firstName === undefined) {
      warnings.push('firstName 값이 없습니다.');
    }
    if (root.sliver === undefined) {
      warnings.push('sliver 값이 없습니다.');
    }

    return makeValidationResult(errors, warnings);
  }

  function makeValidationResult(errors, warnings) {
    return {
      valid: errors.length === 0,
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      issues: errors.concat(warnings)
    };
  }

  function validateScalarPatch(root, patch) {
    if (!isPlainObject(patch)) {
      throw new Error('수정 데이터는 객체여야 합니다.');
    }

    var nameFields = ['firstName', 'lastName'];
    for (var i = 0; i < nameFields.length; i++) {
      var nameField = nameFields[i];
      if (patch[nameField] !== undefined) {
        if (typeof patch[nameField] !== 'string') {
          throw new Error('이름 값은 문자열이어야 합니다.');
        }
        if (patch[nameField].length > 100) {
          throw new Error('이름 값은 100자 이하여야 합니다.');
        }
      }
    }

    var nonNegativeFields = [
      'sliver', 'gold', 'sectcoin', 'gangCoin', 'xiuWei', 'YueLi', 'JingYan', 'SP',
      'HP', 'baoShi', 'BigWorldStrength', 'surplusAttributeNum', 'ArrestNum'
    ];
    for (var n = 0; n < nonNegativeFields.length; n++) {
      var field = nonNegativeFields[n];
      if (patch[field] !== undefined) {
        var value = patch[field];
        if (typeof value !== 'number' || !isFinite(value) || value < 0) {
          throw new Error(field + ' 값은 0 이상의 숫자여야 합니다.');
        }
      }
    }

    if (patch.attribute !== undefined) {
      if (typeof patch.attribute !== 'number' || !isFinite(patch.attribute) || Math.floor(patch.attribute) !== patch.attribute || patch.attribute < 0 || patch.attribute > 20) {
        throw new Error('경지 값은 0부터 20 사이의 정수여야 합니다.');
      }
    }

    if (patch.gameLv !== undefined) {
      if (typeof patch.gameLv !== 'number' || !isFinite(patch.gameLv) || Math.floor(patch.gameLv) !== patch.gameLv || patch.gameLv < 0 || patch.gameLv > 10) {
        throw new Error('난이도 값은 0부터 10 사이의 정수여야 합니다.');
      }
    }

    if (patch.isSandBoxMode !== undefined) {
      if (patch.isSandBoxMode !== 0 && patch.isSandBoxMode !== 1) {
        throw new Error('샌드박스 모드 값은 0 또는 1이어야 합니다.');
      }
    }

    for (var p = 0; p < ATTRIBUTE_PREFIXES.length; p++) {
      for (var s = 0; s < ATTRIBUTE_SUFFIXES.length; s++) {
        var attrKey = 'attribute' + ATTRIBUTE_PREFIXES[p] + '_' + ATTRIBUTE_SUFFIXES[s];
        if (patch[attrKey] !== undefined) {
          if (typeof patch[attrKey] !== 'number' || !isFinite(patch[attrKey]) || patch[attrKey] < 0) {
            throw new Error(attrKey + ' 값은 0 이상의 숫자여야 합니다.');
          }
        }
      }
    }

    if (patch.roleAttribute !== undefined) {
      if (!isPlainObject(patch.roleAttribute)) {
        throw new Error('roleAttribute 값은 객체여야 합니다.');
      }
      for (var key in patch.roleAttribute) {
        if (Object.prototype.hasOwnProperty.call(patch.roleAttribute, key)) {
          var roleValue = patch.roleAttribute[key];
          if (typeof roleValue !== 'number' || !isFinite(roleValue)) {
            throw new Error('roleAttribute의 ' + key + ' 값은 유한한 숫자여야 합니다.');
          }
        }
      }
    }

    var integerFields = ['sect', 'sectLv', 'gang', 'gangLv', 'lichang'];
    for (var intIndex = 0; intIndex < integerFields.length; intIndex++) {
      var intField = integerFields[intIndex];
      if (patch[intField] !== undefined) {
        if (typeof patch[intField] !== 'number' || !isFinite(patch[intField]) || Math.floor(patch[intField]) !== patch[intField]) {
          throw new Error(intField + ' 값은 정수여야 합니다.');
        }
      }
    }
  }

  function applyScalarPatch(root, patch) {
    var data = assertPlayer(root);
    validateScalarPatch(data, patch);

    var scalarFields = [
      'firstName', 'lastName', 'attribute', 'lichang', 'gameLv', 'gameTime', 'saveTime',
      'isSandBoxMode', 'surplusAttributeNum', 'ArrestNum',
      'sliver', 'gold', 'sectcoin', 'gangCoin', 'xiuWei', 'YueLi', 'JingYan', 'SP',
      'BigWorldStrength', 'HP', 'baoShi',
      'sect', 'sectLv', 'gang', 'gangLv'
    ];
    for (var i = 0; i < scalarFields.length; i++) {
      var field = scalarFields[i];
      if (patch[field] !== undefined) {
        data[field] = patch[field];
      }
    }

    for (var p = 0; p < ATTRIBUTE_PREFIXES.length; p++) {
      for (var s = 0; s < ATTRIBUTE_SUFFIXES.length; s++) {
        var attrKey = 'attribute' + ATTRIBUTE_PREFIXES[p] + '_' + ATTRIBUTE_SUFFIXES[s];
        if (patch[attrKey] !== undefined) {
          data[attrKey] = patch[attrKey];
        }
      }
    }

    if (patch.roleAttribute !== undefined) {
      if (!isPlainObject(data.roleAttribute)) {
        data.roleAttribute = {};
      }
      for (var roleKey in patch.roleAttribute) {
        if (Object.prototype.hasOwnProperty.call(patch.roleAttribute, roleKey)) {
          data.roleAttribute[roleKey] = patch.roleAttribute[roleKey];
        }
      }
    }

    return data;
  }

  function upsertItem(root, itemId, deltaOrCount, isDelta) {
    var data = assertPlayer(root);
    var id = Number(itemId);
    if (!isFinite(id) || id <= 0 || Math.floor(id) !== id) {
      throw new Error('아이템 번호가 올바르지 않습니다.');
    }

    var delta = Number(deltaOrCount);
    if (!isFinite(delta)) {
      throw new Error('아이템 수량이 올바르지 않습니다.');
    }

    var list = ensureArray(data, 'listMyItemData');
    var foundIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].itemId) === id) {
        foundIndex = i;
        break;
      }
    }

    var nextCount;
    if (isDelta) {
      var current = foundIndex >= 0 ? Number(list[foundIndex].count) || 0 : 0;
      nextCount = current + delta;
    } else {
      nextCount = delta;
    }

    if (nextCount < 0) {
      throw new Error('아이템 수량은 0 이상이어야 합니다.');
    }

    if (nextCount === 0) {
      if (foundIndex >= 0) {
        list.splice(foundIndex, 1);
      }
      return data;
    }

    if (foundIndex >= 0) {
      list[foundIndex].count = nextCount;
    } else {
      list.push({
        _guid: makeGuid('item', id),
        itemId: id,
        count: nextCount
      });
    }
    return data;
  }

  function removeItem(root, guidOrItemId) {
    var data = assertPlayer(root);
    var list = ensureArray(data, 'listMyItemData');
    var target = guidOrItemId;
    var result = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item) {
        continue;
      }
      var matchGuid = String(item._guid) === String(target) || String(item.guid) === String(target);
      var matchId = Number(item.itemId) === Number(target);
      if (!matchGuid && !matchId) {
        result.push(item);
      }
    }
    data.listMyItemData = result;
    return data;
  }

  function addEquip(root, quipId, opts) {
    var data = assertPlayer(root);
    var id = Number(quipId);
    if (!isFinite(id) || id <= 0) {
      throw new Error('장비 번호가 올바르지 않습니다.');
    }
    var options = isPlainObject(opts) ? opts : {};
    var equip = {
      guid: makeGuid('eq', id),
      quipId: id,
      _quipTypeId: options._quipTypeId !== undefined ? Number(options._quipTypeId) : 0,
      quality: options.quality !== undefined ? Number(options.quality) : 1,
      wearId: options.wearId !== undefined ? Number(options.wearId) : 0,
      IsLock: options.IsLock ? 1 : 0
    };
    var list = ensureArray(data, 'listMyEuipData');
    list.push(equip);
    return equip;
  }

  function updateEquip(root, guid, patch) {
    var data = assertPlayer(root);
    if (!isPlainObject(patch)) {
      throw new Error('장비 수정 데이터는 객체여야 합니다.');
    }
    var list = ensureArray(data, 'listMyEuipData');
    for (var i = 0; i < list.length; i++) {
      var equip = list[i];
      if (equip && String(equip.guid) === String(guid)) {
        if (patch.quality !== undefined) {
          equip.quality = Number(patch.quality);
        }
        if (patch.wearId !== undefined) {
          equip.wearId = Number(patch.wearId);
        }
        if (patch._quipTypeId !== undefined) {
          equip._quipTypeId = Number(patch._quipTypeId);
        }
        if (patch.IsLock !== undefined) {
          equip.IsLock = (patch.IsLock === true || Number(patch.IsLock) === 1) ? 1 : 0;
        }
        return equip;
      }
    }
    return null;
  }

  function removeEquip(root, guid) {
    var data = assertPlayer(root);
    var list = ensureArray(data, 'listMyEuipData');
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || String(list[i].guid) !== String(guid)) {
        next.push(list[i]);
      }
    }
    data.listMyEuipData = next;

    if (isPlainObject(data.myEuipList)) {
      for (var slot in data.myEuipList) {
        if (Object.prototype.hasOwnProperty.call(data.myEuipList, slot)) {
          var equipped = data.myEuipList[slot];
          if (equipped && String(equipped.guid) === String(guid)) {
            data.myEuipList[slot] = null;
          }
        }
      }
    }
    return data;
  }

  function toggleIdInList(root, listKey, id) {
    var data = assertPlayer(root);
    var list = ensureArray(data, listKey);
    var numberId = Number(id);
    if (!isFinite(numberId) || Math.floor(numberId) !== numberId) {
      throw new Error('번호가 올바르지 않습니다.');
    }
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i]) === numberId) {
        list.splice(i, 1);
        return { present: false, list: list };
      }
    }
    list.push(numberId);
    return { present: true, list: list };
  }

  function unlockAllMeridians(root, catalog) {
    var data = assertPlayer(root);
    var acupoints = [];
    var collaterals = [];
    if (catalog && isPlainObject(catalog)) {
      if (Array.isArray(catalog.acupoints)) {
        acupoints = catalog.acupoints;
      }
      if (Array.isArray(catalog.collaterals)) {
        collaterals = catalog.collaterals;
      }
    }

    if (!acupoints.length) {
      acupoints = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    }
    if (!collaterals.length) {
      collaterals = [1, 2, 3, 4, 5];
    }

    var acuList = ensureArray(data, 'acupointDataList');
    var jlList = ensureArray(data, 'acupointJlDataList');
    var acuSeen = {};
    var jlSeen = {};
    var i;
    for (i = 0; i < acuList.length; i++) {
      acuSeen[Number(acuList[i])] = true;
    }
    for (i = 0; i < jlList.length; i++) {
      jlSeen[Number(jlList[i])] = true;
    }
    for (i = 0; i < acupoints.length; i++) {
      var rawAcu = acupoints[i];
      var acuId = Number(rawAcu && typeof rawAcu === 'object' ? rawAcu.id : rawAcu);
      if (isFinite(acuId) && acuId > 0 && !acuSeen[acuId]) {
        acuList.push(acuId);
        acuSeen[acuId] = true;
      }
    }
    for (i = 0; i < collaterals.length; i++) {
      var rawJl = collaterals[i];
      var jlId = Number(rawJl && typeof rawJl === 'object' ? rawJl.id : rawJl);
      if (isFinite(jlId) && jlId > 0 && !jlSeen[jlId]) {
        jlList.push(jlId);
        jlSeen[jlId] = true;
      }
    }
    return data;
  }

  function addWuxue(root, groupId, skillIds) {
    var data = assertPlayer(root);
    var skills = ensureObject(data, 'm_allSkillList');
    var key = String(groupId);
    var incoming = Array.isArray(skillIds) ? skillIds.map(String) : [];
    if (!Array.isArray(skills[key])) {
      skills[key] = [];
    }
    for (var i = 0; i < incoming.length; i++) {
      if (skills[key].indexOf(incoming[i]) === -1) {
        skills[key].push(incoming[i]);
      }
    }
    return skills[key];
  }

  function removeWuxue(root, groupId) {
    var data = assertPlayer(root);
    if (isPlainObject(data.m_allSkillList)) {
      delete data.m_allSkillList[String(groupId)];
    }
    return data;
  }

  function upsertSorcery(root, id, wear) {
    var data = assertPlayer(root);
    var sorceryId = Number(id);
    if (!isFinite(sorceryId) || Math.floor(sorceryId) !== sorceryId) {
      throw new Error('술법 번호가 올바르지 않습니다.');
    }
    var list = ensureArray(data, 'listMySorcery');
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].id) === sorceryId) {
        list[i].wear = wear ? 1 : 0;
        return list[i];
      }
    }
    list.push({ id: sorceryId, wear: wear ? 1 : 0 });
    return list[list.length - 1];
  }

  function removeSorcery(root, id) {
    var data = assertPlayer(root);
    var list = ensureArray(data, 'listMySorcery');
    var target = Number(id);
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || Number(list[i].id) !== target) {
        next.push(list[i]);
      }
    }
    data.listMySorcery = next;
    return data;
  }

  function updatePartnerAttr(root, index, fields) {
    var data = assertPlayer(root);
    var list = ensureArray(data, 'listPartnerAttribute');
    var idx = Number(index);
    if (!isFinite(idx) || Math.floor(idx) !== idx || idx < 0) {
      throw new Error('동료 속성 번호가 올바르지 않습니다.');
    }
    while (list.length <= idx) {
      list.push({});
    }
    if (!isPlainObject(list[idx])) {
      list[idx] = {};
    }
    if (isPlainObject(fields)) {
      for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          list[idx][key] = fields[key];
        }
      }
    }
    return list[idx];
  }

  function applyPreset(root, presetId, catalog) {
    var data = assertPlayer(root);
    var preset = null;
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === presetId) {
        preset = PRESETS[i];
        break;
      }
    }
    if (!preset) {
      throw new Error('알 수 없는 프리셋입니다.');
    }
    preset.apply(data, catalog);
    return data;
  }

  var PRESETS = [
    {
      id: 'wealth',
      name: '부유한 시작',
      desc: '은자, 금, 문파 기여, 무맹 기여를 넉넉하게 지급합니다.',
      apply: function (root) {
        applyScalarPatch(root, {
          sliver: Math.max(Number(root.sliver) || 0, 500000),
          gold: Math.max(Number(root.gold) || 0, 5000),
          sectcoin: Math.max(Number(root.sectcoin) || 0, 50000),
          gangCoin: Math.max(Number(root.gangCoin) || 0, 50000)
        });
        return root;
      }
    },
    {
      id: 'cultivation',
      name: '수련 지원',
      desc: '수련 자원과 잠재 능력치를 대폭 올립니다.',
      apply: function (root) {
        applyScalarPatch(root, {
          xiuWei: Math.max(Number(root.xiuWei) || 0, 999999),
          YueLi: Math.max(Number(root.YueLi) || 0, 50000),
          JingYan: Math.max(Number(root.JingYan) || 0, 50000),
          surplusAttributeNum: Math.max(Number(root.surplusAttributeNum) || 0, 50),
          SP: Math.max(Number(root.SP) || 0, 100)
        });
        return root;
      }
    },
    {
      id: 'meridians',
      name: '경맥 개방',
      desc: '모든 경혈과 경락을 열어 줍니다.',
      apply: function (root, catalog) {
        unlockAllMeridians(root, catalog);
        return root;
      }
    },
    {
      id: 'recovery',
      name: '상태 완전 회복',
      desc: '체력과 내공, 기혈을 최대로 회복합니다.',
      apply: function (root) {
        var data = assertPlayer(root);
        if (!isPlainObject(data.roleAttribute)) {
          data.roleAttribute = createRoleAttribute();
        }
        data.HP = Math.max(Number(data.HP) || 0, 9999);
        data.baoShi = Math.max(Number(data.baoShi) || 0, 100);
        data.BigWorldStrength = Math.max(Number(data.BigWorldStrength) || 0, 100);
        data.roleAttribute.blood = Math.max(Number(data.roleAttribute.blood) || 0, 9999);
        data.roleAttribute.zhenQ = Math.max(Number(data.roleAttribute.zhenQ) || 0, 9999);
        return data;
      }
    },
    {
      id: 'clean_record',
      name: '체포 기록 초기화',
      desc: '체포 기록을 모두 지웁니다.',
      apply: function (root) {
        applyScalarPatch(root, { ArrestNum: 0 });
        return root;
      }
    },
    {
      id: 'starter_supply',
      name: '초반 보급품',
      desc: '초반에 필요한 아이템을 지급합니다.',
      apply: function (root, catalog) {
        var ids = [901000, 901001];
        if (catalog && Array.isArray(catalog.starterItems)) {
          ids = catalog.starterItems;
        } else if (catalog && Array.isArray(catalog.items)) {
          var medIds = catalog.items.filter(function (x) { return x && x.bucket === 'medicine'; }).slice(0, 2).map(function (x) { return x.id; });
          if (medIds.length) ids = medIds;
        }
        for (var i = 0; i < ids.length; i++) {
          upsertItem(root, ids[i], 5, true);
        }
        return root;
      }
    }
  ];

  var PRESET_MAP = {};
  for (var presetIndex = 0; presetIndex < PRESETS.length; presetIndex++) {
    PRESET_MAP[PRESETS[presetIndex].id] = PRESETS[presetIndex];
  }

  return {
    REALM_NAMES: REALM_NAMES,
    DIFFICULTY_NAMES: DIFFICULTY_NAMES,
    EQUIP_SLOTS: EQUIP_SLOTS,
    PRESETS: PRESETS,
    PRESET_MAP: PRESET_MAP,
    createSampleSave: createSampleSave,
    makeDemoSave: createSampleSave,
    assertPlayer: assertPlayer,
    summarizeSave: summarizeSave,
    validateSave: validateSave,
    applyScalarPatch: applyScalarPatch,
    upsertItem: upsertItem,
    removeItem: removeItem,
    addEquip: addEquip,
    updateEquip: updateEquip,
    removeEquip: removeEquip,
    toggleIdInList: toggleIdInList,
    unlockAllMeridians: unlockAllMeridians,
    addWuxue: addWuxue,
    removeWuxue: removeWuxue,
    upsertSorcery: upsertSorcery,
    removeSorcery: removeSorcery,
    updatePartnerAttr: updatePartnerAttr,
    applyPreset: applyPreset
  };
});