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
            return data.models
                .map(model => model.name.replace('models/', ''))
                .filter(name => name.includes('generateContent'))
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
            // Gemini expects the 'contents' field to be the array of messages.
            // 注意：Gemini 2.5 系列是推理模型，"思考"消耗的 token 也算在 maxOutputTokens 总预算里。
            // 预算给太低（比如旧版的 2048），思考本身就可能把预算耗光，导致正文被截断甚至完全空白。
            // 这里把预算提高，并且给 thinkingBudget 设一个上限，避免思考无限制地把预算全部吃掉。
            body = JSON.stringify({
                contents: messages,
                generationConfig: {
                    maxOutputTokens: 8192,
                    temperature: 1,
                    thinkingConfig: { thinkingBudget: 1024 }
                }
            });
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
