const ApiHandler = {
    /**
     * Gets the base URL from a given endpoint.
     * Strips common suffixes like /v1/chat/completions or /v1.
     * @param {string} endpoint - The full endpoint URL.
     * @returns {string} The base URL.
     */
    getBaseUrl(endpoint) {
        let url = endpoint.replace(/\/$/, ''); // Remove trailing slash
        // 【新增·兼容 GLM/智谱等 /v4 风格地址】原来只认识 /v1，用户填 GLM 的
        // https://open.bigmodel.cn/api/paas/v4 或带了 /chat/completions 的完整地址时会拼错。
        // 这里先统一去掉结尾的 /chat/completions，再去掉结尾的 /v1 或 /v4，逻辑对旧版 /v1 完全兼容。
        url = url.replace(/\/chat\/completions$/, '');
        url = url.replace(/\/(v1|v4)$/, '');
        return url;
    },

    /**
     * Fetches the list of available models from the specified API endpoint.
     */
    async fetchModels(platform, endpoint, apiKey) {
        if (platform === 'openai' || platform === 'MyAPI') {
            if (platform === 'MyAPI' && !endpoint) {
                throw new Error('请先填写 MyAPI 的接口地址');
            }
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
            // 排掉非对话类模型（embedding/视觉理解/语音/图像/审核等），
            // 而不是靠 "gpt"/"text-" 白名单救场——之前的写法因为 && 优先级比 || 高，
            // 实际上变成了"只要不含 embed 或 vision 就放行"，会把 whisper/dall-e/tts 这类也混进来
            return data.data
                .map(model => model.id)
                .filter(id => !id.includes('embed') && !id.includes('vision') && !id.includes('whisper') && !id.includes('tts') && !id.includes('dall-e') && !id.includes('moderation'))
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
        } else if (platform === 'glm') {
            // 智谱官方目前没有公开、稳定的、和 OpenAI /v1/models 完全对等的模型列表接口
            // （反代/网关不一定支持这个路径）。这里先按 OpenAI 兼容方式尝试请求一次
            // {baseUrl}/models，请求失败或返回空就直接兜底成一份常见模型的静态列表，
            // 保证下拉框不会因为这个接口不存在而空着。
            const FALLBACK_GLM_MODELS = [
                'glm-5.3', 'glm-5.2', 'glm-5', 'glm-5-turbo', 'glm-5-air',
                'glm-4.7', 'glm-4.7-flash', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash',
                'glm-4-flash', 'glm-4-plus', 'glm-4v', 'glm-4v-flash'
            ];
            const baseUrl = this.getBaseUrl(endpoint) || 'https://open.bigmodel.cn/api/paas';
            try {
                const response = await fetch(`${baseUrl}/v4/models`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!response.ok) throw new Error('models endpoint not available');
                const data = await response.json();
                const ids = (data.data || []).map(m => m.id).filter(Boolean);
                return (ids.length ? ids : FALLBACK_GLM_MODELS).sort();
            } catch (e) {
                return FALLBACK_GLM_MODELS.sort();
            }
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
                },
                // 恋人陪伴类对话经常涉及亲密、情感浓度比较高的内容，稍微松一点安全过滤的阈值，
                // 避免正常的情侣对话被误拦截。这不是关闭安全审核，只是不用默认的中等及以上就拦。
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
            };
            if (systemText) bodyObj.systemInstruction = { parts: [{ text: systemText }] };
            body = JSON.stringify(bodyObj);
            return { url, options: { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) } };
        }
        
        // Handles 'openai', 'MyAPI', 'glm'（智谱/GLM 官方接口本身就是 OpenAI Chat Completions 兼容格式）
        headers['Authorization'] = `Bearer ${apiKey}`;
        if (platform === 'openai') {
            url = 'https://api.openai.com/v1/chat/completions';
        } else if (platform === 'glm') {
            // 【新增·GLM 官方接口】getBaseUrl 会把用户填的地址里 /v4 这类版本后缀去掉（方便兼容各种填法），
            // 所以这里要自己把 /v4/chat/completions 加回去，不能只加 /chat/completions——
            // 智谱的真实路径是 /api/paas/v4/chat/completions，少了 /v4 会直接 404。
            const baseUrl = this.getBaseUrl(endpoint) || 'https://open.bigmodel.cn/api/paas';
            url = `${baseUrl}/v4/chat/completions`;
        } else { // MyAPI
            if (!endpoint) {
                throw new Error('请先填写 MyAPI 的接口地址');
            }
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
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;

            // 拿不到正文的时候，把 Gemini 真正给出的原因扒出来，而不是让调用方只看到一句
            // 千篇一律的"AI 返回空"——不然每次都得靠猜，根本不知道是哪种情况。
            if (data.promptFeedback?.blockReason) {
                throw new Error(`请求被内容安全过滤拦截了（${data.promptFeedback.blockReason}），可能是这次的内容触发了 Gemini 的审核，换个说法再试试`);
            }
            const candidate = data.candidates?.[0];
            const finishReason = candidate?.finishReason;
            if (finishReason === 'SAFETY') {
                const hit = (candidate.safetyRatings || []).filter(r => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM').map(r => r.category.replace('HARM_CATEGORY_', ''));
                throw new Error(`回复被内容安全过滤拦截了${hit.length ? '（' + hit.join('、') + '）' : ''}，换个说法再试试`);
            }
            if (finishReason === 'MAX_TOKENS') {
                throw new Error('回复还没写正文，"思考"就把预算用完了——可以试着把 maxOutputTokens 调更大，或者简化一下这次的问题');
            }
            if (finishReason === 'RECITATION') {
                throw new Error('触发了 Gemini 的原创性/重复内容检测，换个问法再试试');
            }
            return text; // 确实没有更多信息，交回调用方按通用的"AI 返回空"处理
        } else { // Handles 'openai', 'MyAPI', 'glm'（GLM 返回结构和 OpenAI 一致，直接复用）
            return data.choices?.[0]?.message?.content;
        }
    }
};
