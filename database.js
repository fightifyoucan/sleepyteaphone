// 眠茶机 - 数据管理中心 (database.js)
// 强制空白版 v2

const DB = {
    init: function() {
        // 我改了这里的名字(加了v2)，强制你的浏览器建立新的空白数据库
        // 这样以前的"AI助理"、"亲爱的"都会看不见
        if (localStorage.getItem('m-tea-contacts-v2') === null) {
            this.saveContacts([]); // 强制为空
        }
        if (localStorage.getItem('m-tea-chats-v2') === null) {
            this.saveChats({}); // 强制为空
        }
        if (localStorage.getItem('m-tea-moments-v2') === null) {
            this.saveMoments([]); // 强制为空
        }
        if (localStorage.getItem('m-tea-me-v2') === null) {
            this.setDefaultMe();
        }
    },

    // --- Contacts ---
    getContacts: function() {
        return JSON.parse(localStorage.getItem('m-tea-contacts-v2')) || [];
    },
    saveContacts: function(contacts) {
        localStorage.setItem('m-tea-contacts-v2', JSON.stringify(contacts));
    },
    getContact: function(id) {
        const contacts = this.getContacts();
        return contacts.find(c => c.id === id);
    },
    saveContact: function(contactData) {
        let contacts = this.getContacts();
        const index = contacts.findIndex(c => c.id === contactData.id);
        if (index > -1) {
            contacts[index] = { ...contacts[index], ...contactData }; 
        } else {
            if (!contactData.id) contactData.id = `contact_${Date.now()}`;
            contacts.push(contactData); 
        }
        this.saveContacts(contacts);
    },
    deleteContact: function(id) {
        let contacts = this.getContacts();
        contacts = contacts.filter(c => c.id !== id);
        this.saveContacts(contacts);
        
        let chats = this.getChats();
        delete chats[id];
        this.saveChats(chats);
    },

    // --- Chats ---
    getChats: function() {
        return JSON.parse(localStorage.getItem('m-tea-chats-v2')) || {};
    },
    saveChats: function(chats) {
        localStorage.setItem('m-tea-chats-v2', JSON.stringify(chats));
    },
    getChatById: function(contactId) {
        const chats = this.getChats();
        return chats[contactId] || [];
    },
    addMessage: function(contactId, message) {
        const chats = this.getChats();
        if (!chats[contactId]) {
            chats[contactId] = [];
        }
        chats[contactId].push(message);
        this.saveChats(chats);
    },

    // --- Moments ---
    saveMoments: function(moments) {
        localStorage.setItem('m-tea-moments-v2', JSON.stringify(moments));
    },

    // --- Me ---
    saveMe: function(meData) {
        localStorage.setItem('m-tea-me-v2', JSON.stringify(meData));
    },
    setDefaultMe: function() {
        const defaultMe = {
            name: '我',
            avatar: '👤',
            id: '5201314'
        };
        this.saveMe(defaultMe);
    }
};

DB.init();