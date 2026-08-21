const ApiHandler = {
    /**
     * Gets the base URL from a given endpoint.
     * Strips common suffixes like /v1/chat/completions or /v1.
     * @param {string} endpoint - The full endpoint URL.
     * @returns {string} The base URL.
     */
    getBaseUrl(endpoint) {
        let url = endpoint.replace(/\/$/, ''); // Remove trailing slash
        if (url.endsWith('/v1/chat/completions')) {
            return url.replace('/v1/chat/completions', '');
        }
        if (url.endsWith('/v1')) {
            return url.replace('/v1', '');
        }
        return url;
    },

    /**
     * Fetches the list of available models from the specified API endpoint.
     */
    async fetchModels(platform, endpoint, apiKey) {
        if (platform === 'openai' || platform === 'MyAPI') {
            const baseUrl = (platform === 'openai') 
                ? 'https://api.openai.com' 
                : this.getBaseUrl(endpoint);
            
            const url = `${baseUrl}/v1/models`;
            const headers = { 'Authorization': `Bearer ${apiKey}` };
            const response = await fetch(url, { headers });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`Failed to fetch models: ${err.error?.message || response.statusText}`);
            }
            const data = await response.json();
            // Filter for models that can be used with the chat completions endpoint
            return data.data
                .map(model => model.id)
                .filter(id => id.includes('gpt') || id.includes('text-') || !id.includes('embed') && !id.includes('vision'))
                .sort();
        } else if (platform === 'gemini') {
            const cleanedEndpoint = (endpoint || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
            const url = `${cleanedEndpoint}/v1beta/models?key=${apiKey}`;
            const response = await fetch(url);
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`Failed to fetch models: ${err.error?.message || response.statusText}`);
            }
            const data = await response.json();
            // 之前这里先 map 成了纯名字字符串，再拿 "generateContent" 去搜这个名字——
            // 但模型名字（比如 "gemini-2.5-pro"）本来就不可能包含这个词，导致永远筛不出结果，
            // 一直报"未找到模型数据"。真正标记"是否支持 generateContent"的字段是模型对象自己的
            // supportedGenerationMethods 数组，得在还没把对象简化成名字字符串之前去检查它。
            return data.models
                .filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
                .map(model => model.name.replace('models/', ''))
                .sort();
        }
        return [];
    },

    /**
     * Generates the appropriate URL and options for sending a chat message.
     */
    generateChatPayload(platform, endpoint, apiKey, model, messages) {
        const headers = { 'Content-Type': 'application/json' };
        let body;
        let url;

        if (platform === 'gemini') {
            const cleanedEndpoint = (endpoint || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
            url = `${cleanedEndpoint}/v1beta/models/${model}:generateContent?key=${apiKey}`;

            // 项目里绝大多数地方构造的都是 OpenAI 风格的消息数组：{role:'system'|'user'|'assistant', content:'...'}，
            // 然后不管选的是哪个平台，都直接调用这个函数。但 Gemini 原生 REST 接口要的格式不一样：
            //   1. 没有 'system' 这个角色，系统提示词要放进单独的 systemInstruction 字段
            //   2. 'assistant' 要改叫 'model'
            //   3. 每条消息内容要包在 parts:[{text}] 里，而不是一个 content 字符串
            // 之前这里是把 messages 原样塞进 contents，官方 Gemini 接口收到这种格式基本会报错或者返回异常，
            // 这正是"反代能连、官方连不上"的根本原因——反代很可能自己做了兼容转换，官方接口没有。
            // 这里统一做转换，兼容两种输入：已经是 {role,parts} 的（比如通话功能自己转换过的），
            // 和 {role,content} 的（其余大多数地方用的）。
            let systemText = '';
            const contents = [];
            (messages || []).forEach(m => {
                if (m.role === 'system') {
                    systemText += (systemText ? '\n' : '') + (m.content || '');
                    return;
                }
                const role = m.role === 'assistant' ? 'model' : (m.role || 'user');
                const parts = m.parts ? m.parts : [{ text: m.content || '' }];
                contents.push({ role, parts });
            });

            const bodyObj = {
                contents,
                generationConfig: {
                    maxOutputTokens: 8192,
                    temperature: 1,
                    thinkingConfig: { thinkingBudget: 1024 }
                }
            };
            if (systemText) bodyObj.systemInstruction = { parts: [{ text: systemText }] };
            body = JSON.stringify(bodyObj);
            return { url, options: { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) } };
        }
        
        // Handles 'openai' and 'MyAPI' (OpenAI-like)
        headers['Authorization'] = `Bearer ${apiKey}`;
        if (platform === 'openai') {
            url = 'https://api.openai.com/v1/chat/completions';
        } else { // MyAPI
            const baseUrl = this.getBaseUrl(endpoint);
            url = `${baseUrl}/v1/chat/completions`;
        }
        
        body = JSON.stringify({
            model: model,
            messages: messages,
            max_tokens: 8192,
            temperature: 1
        });
        return { url, options: { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) } };
    },

    /**
     * Parses the chat response from different platforms.
     */
    parseChatResponse(platform, data) {
        if (platform === 'gemini') {
            return data.candidates?.[0]?.content?.parts?.[0]?.text;
        } else { // Handles 'openai' and 'MyAPI'
            return data.choices?.[0]?.message?.content;
        }
    }
};
