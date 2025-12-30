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
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
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
    generateChatPayload(platform, endpoint, apiKey, model, userMessage) {
        const headers = { 'Content-Type': 'application/json' };
        let body;
        let url;

        if (platform === 'gemini') {
            const cleanedEndpoint = endpoint.replace(/\/$/, '');
            url = `${cleanedEndpoint}/models/${model}:generateContent?key=${apiKey}`;
            body = JSON.stringify({ contents: [{ parts: [{ text: userMessage }] }] });
            return { url, options: { method: 'POST', headers, body } };
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
            messages: [{ role: "user", content: userMessage }]
        });
        return { url, options: { method: 'POST', headers, body } };
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
