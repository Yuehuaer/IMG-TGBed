export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);
    let fileId = params.id;
    
    // 检查是否是 R2 存储的文件（以 r2: 开头）
    if (fileId.startsWith('r2:')) {
        return await handleR2File(context, fileId.substring(3)); // 移除 r2: 前缀
    }
    
    // 先检查 KV 中是否有该文件的元数据，判断存储类型
    let record = null;
    let isR2Storage = false;
    
    if (env.img_url) {
        // 尝试多种前缀查找（兼容新旧 Key 格式）
        const prefixes = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', ''];
        for (const prefix of prefixes) {
            const key = `${prefix}${fileId}`;
            record = await env.img_url.getWithMetadata(key);
            if (record && record.metadata) {
                isR2Storage = record.metadata.storage === 'r2' || record.metadata.storageType === 'r2';
                break;
            }
        }
    }
    
    // 如果是 R2 存储，从 R2 获取文件
    if (isR2Storage && env.R2_BUCKET) {
        const r2Key = record?.metadata?.r2Key || fileId;
        return await handleR2File(context, r2Key, record);
    }
    
    // 从 Telegram 获取文件（原有逻辑）
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search
    if (url.pathname.length > 39) { // Path length > 39 indicates file uploaded via Telegram Bot API
        const formdata = new FormData();
        formdata.append("file_id", url.pathname);

        const requestOptions = {
            method: "POST",
            body: formdata,
            redirect: "follow"
        };
        // /file/AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA.png
        //get the AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA
        console.log(url.pathname.split(".")[0].split("/")[2])
        const filePath = await getFilePath(env, url.pathname.split(".")[0].split("/")[2]);
        console.log(filePath)
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    // If the response is OK, proceed with further checks
    if (!response.ok) return response;

    // Log response details
    console.log(response.ok, response.status);

    // Allow the admin page to directly view the image
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return response;
    }

    // Check if KV storage is available
    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return response;  // Directly return image response, terminate execution
    }

    // The following code executes only if KV is available
    // 如果之前没有找到记录，尝试重新获取
    if (!record || !record.metadata) {
        record = await env.img_url.getWithMetadata(params.id);
    }
    
    if (!record || !record.metadata) {
        // Initialize metadata if it doesn't exist
        console.log("Metadata not found, initializing...");
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // Handle based on ListType and Label
    if (metadata.ListType === "White") {
        return response;
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // Check if WhiteList_Mode is enabled
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // If no metadata or further actions required, moderate content and add to KV if needed
    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        console.log("Content marked as adult, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Error during content moderation: " + error.message);
            // Moderation failure should not affect user experience, continue processing
        }
    }

    // Only save metadata if content is not adult content
    // Adult content cases are already handled above and will not reach this point
    console.log("Saving metadata");
    await env.img_url.put(params.id, "", { metadata });

    // 返回文件内容，并设置正确的文件名用于下载
    const originalFileName = metadata.fileName || params.id;
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Disposition', `inline; filename="${encodeURIComponent(originalFileName)}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`);
    
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, {
            method: 'GET',
        });

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const responseData = await res.json();
        const { ok, result } = responseData;

        if (ok && result) {
            return result.file_path;
        } else {
            console.error('Error in response data:', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}

// R2 文件处理函数
async function handleR2File(context, r2Key, record = null) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    
    if (!env.R2_BUCKET) {
        return new Response('R2 storage not configured', { status: 500 });
    }
    
    try {
        const object = await env.R2_BUCKET.get(r2Key);
        
        if (!object) {
            return new Response('File not found in R2', { status: 404 });
        }
        
        // 如果没有 record，尝试从 KV 获取
        if (!record && env.img_url) {
            record = await env.img_url.getWithMetadata(`r2:${r2Key}`);
        }
        
        // 检查访问控制
        if (record?.metadata?.ListType === 'Block' || record?.metadata?.Label === 'adult') {
            const referer = request.headers.get('Referer');
            const isAdmin = referer?.includes(`${url.origin}/admin`);
            if (!isAdmin) {
                const redirectUrl = referer 
                    ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" 
                    : `${url.origin}/block-img.html`;
                return Response.redirect(redirectUrl, 302);
            }
        }
        
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Content-Length', object.size);
        headers.set('Cache-Control', 'public, max-age=31536000');
        
        const fileName = object.customMetadata?.fileName || record?.metadata?.fileName || r2Key;
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        
        return new Response(object.body, { headers });
    } catch (error) {
        console.error('R2 fetch error:', error);
        return new Response('Error fetching file from R2: ' + error.message, { status: 500 });
    }
}