// 眠茶机 - 数据管理中心 (database.js)
// v3: 数据存到 IndexedDB（通过 Dexie），不再受 localStorage 5-10MB 限制
// 启动时会自动从老的 localStorage 迁移到 IndexedDB，迁移完成后清掉 localStorage 里的大数据
// 对外 API 与旧版完全一致，所有同步方法照常工作（用内存缓存 + 异步持久化）

const DB = (function() {
    // ---- 内存缓存（所有同步API都从这读）----
    let _contacts = [];
    let _chats = {};
    let _moments = [];
    let _coreads = {};  // 共读记录：{ id: record }
    let _me = null;
    let _ready = false;
    
    // ---- Dexie 数据库 ----
    let _db = null;
    function _initDexie() {
        if (typeof Dexie === 'undefined') return null;
        if (_db) return _db;
        _db = new Dexie('MTeaDB');
        _db.version(1).stores({
            kv: 'key'  // 简单 key-value 存所有大对象
        });
        return _db;
    }
    
    // ---- 异步持久化（不阻塞同步API）----
    let _pendingSaves = {};
    let _saveTimer = null;
    function _scheduleSave(key, value) {
        _pendingSaves[key] = value;
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(_flushSaves, 200);
    }
    async function _flushSaves() {
        if (!_db || Object.keys(_pendingSaves).length === 0) return;
        const tasks = Object.entries(_pendingSaves).map(([k, v]) => _db.kv.put({ key: k, value: v }));
        _pendingSaves = {};
        try { await Promise.all(tasks); } catch(e) { console.error('[DB] 保存失败', e); }
    }
    // 页面关闭前立即保存
    window.addEventListener('beforeunload', () => {
        if (!_db || Object.keys(_pendingSaves).length === 0) return;
        // 同步写一次（虽然IndexedDB是异步但浏览器会等一会）
        for (const [k, v] of Object.entries(_pendingSaves)) {
            _db.kv.put({ key: k, value: v });
        }
    });
    
    // ---- 启动初始化 ----
    async function _init() {
        const db = _initDexie();
        if (!db) {
            // Dexie 不可用时降级到 localStorage
            console.warn('[DB] Dexie 不可用，降级到 localStorage 模式');
            _contacts = JSON.parse(localStorage.getItem('m-tea-contacts-v2') || '[]');
            _chats = JSON.parse(localStorage.getItem('m-tea-chats-v2') || '{}');
            _moments = JSON.parse(localStorage.getItem('m-tea-moments-v2') || '[]');
            _coreads = JSON.parse(localStorage.getItem('m-tea-coreads-v2') || '{}');
            _me = JSON.parse(localStorage.getItem('m-tea-me-v2') || 'null');
            _ready = true;
            return;
        }
        
        // 从 IndexedDB 加载
        try {
            const [c, ch, m, me, cr] = await Promise.all([
                db.kv.get('contacts').catch(() => null),
                db.kv.get('chats').catch(() => null),
                db.kv.get('moments').catch(() => null),
                db.kv.get('me').catch(() => null),
                db.kv.get('coreads').catch(() => null)
            ]);
            
            // 如果 IndexedDB 里没数据，尝试从 localStorage 迁移
            const lsContacts = localStorage.getItem('m-tea-contacts-v2');
            const lsChats = localStorage.getItem('m-tea-chats-v2');
            const lsMoments = localStorage.getItem('m-tea-moments-v2');
            const lsMe = localStorage.getItem('m-tea-me-v2');
            const migratedFlag = localStorage.getItem('_db_to_indexeddb_done');
            
            if (!migratedFlag && (lsContacts || lsChats)) {
                console.log('[DB] 开始把数据从 localStorage 迁移到 IndexedDB...');
                _contacts = JSON.parse(lsContacts || '[]');
                _chats = JSON.parse(lsChats || '{}');
                _moments = JSON.parse(lsMoments || '[]');
                _me = JSON.parse(lsMe || 'null');
                _coreads = JSON.parse(localStorage.getItem('m-tea-coreads-v2') || '{}');
                // 立即写入 IndexedDB
                await db.kv.bulkPut([
                    { key: 'contacts', value: _contacts },
                    { key: 'chats', value: _chats },
                    { key: 'moments', value: _moments },
                    { key: 'me', value: _me }
                ]);
                // 迁移完成后清掉 localStorage 里的大数据（释放空间）
                localStorage.removeItem('m-tea-contacts-v2');
                localStorage.removeItem('m-tea-chats-v2');
                localStorage.removeItem('m-tea-moments-v2');
                localStorage.removeItem('m-tea-coreads-v2');
                localStorage.removeItem('m-tea-me-v2');
                localStorage.setItem('_db_to_indexeddb_done', '1');
                console.log('[DB] ✅ 迁移完成');
            } else {
                _contacts = (c && c.value) || [];
                _chats = (ch && ch.value) || {};
                _moments = (m && m.value) || [];
                _coreads = (cr && cr.value) || {};
                _me = (me && me.value) || null;
            }
        } catch(e) {
            console.error('[DB] 初始化失败，使用空数据', e);
            _contacts = []; _chats = {}; _moments = []; _coreads = {}; _me = null;
        }
        
        if (!_me) {
            _me = { name: '我', avatar: '👤', id: '5201314' };
            _scheduleSave('me', _me);
        }
        
        _ready = true;
        // 通知页面 DB 已就绪
        window.dispatchEvent(new CustomEvent('db-ready'));
    }
    
    // ---- 对外 API（保持和旧版一致）----
    return {
        readyPromise: null, // 后面赋值
        
        init: function() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = _init();
            return this.readyPromise;
        },
        
        isReady: function() { return _ready; },
        
        // --- Contacts ---
        getContacts: function() {
            return _contacts;
        },
        saveContacts: function(contacts) {
            _contacts = contacts || [];
            _scheduleSave('contacts', _contacts);
        },
        getContact: function(id) {
            return _contacts.find(c => c.id === id);
        },
        saveContact: function(contactData) {
            const index = _contacts.findIndex(c => c.id === contactData.id);
            if (index > -1) {
                _contacts[index] = { ..._contacts[index], ...contactData };
            } else {
                if (!contactData.id) contactData.id = `contact_${Date.now()}`;
                _contacts.push(contactData);
            }
            _scheduleSave('contacts', _contacts);
        },
        deleteContact: function(id) {
            _contacts = _contacts.filter(c => c.id !== id);
            delete _chats[id];
            _scheduleSave('contacts', _contacts);
            _scheduleSave('chats', _chats);
        },
        
        // --- Chats ---
        getChats: function() {
            return _chats;
        },
        saveChats: function(chats) {
            _chats = chats || {};
            _scheduleSave('chats', _chats);
        },
        getChatById: function(contactId) {
            return _chats[contactId] || [];
        },
        addMessage: function(contactId, message) {
            if (!_chats[contactId]) _chats[contactId] = [];
            _chats[contactId].push(message);
            _scheduleSave('chats', _chats);
        },
        
        // --- Moments ---
        getMoments: function() {
            return _moments;
        },
        saveMoments: function(moments) {
            _moments = moments || [];
            _scheduleSave('moments', _moments);
        },

        // --- CoReads 共读记录（map: id -> record）---
        getCoReads: function() { return _coreads; },
        saveCoReads: function(coreads) { _coreads = coreads || {}; _scheduleSave('coreads', _coreads); },
        getCoRead: function(id) { return _coreads[id] || null; },
        saveCoRead: function(record) { if (!record || !record.id) return; _coreads[record.id] = record; _scheduleSave('coreads', _coreads); },
        deleteCoRead: function(id) { delete _coreads[id]; _scheduleSave('coreads', _coreads); },
        
        // --- Me ---
        getMe: function() {
            return _me;
        },
        saveMe: function(meData) {
            _me = meData;
            _scheduleSave('me', _me);
        },
        setDefaultMe: function() {
            this.saveMe({ name: '我', avatar: '👤', id: '5201314' });
        },
        
        // --- 工具方法 ---
        // 立即刷新所有 pending 保存
        flush: async function() {
            await _flushSaves();
        },
        // 清空所有数据（重置用）
        clearAll: async function() {
            _contacts = []; _chats = {}; _moments = []; _coreads = {}; _me = null;
            if (_db) await _db.kv.clear();
        }
    };
})();

// 自动初始化（异步）
DB.init();
