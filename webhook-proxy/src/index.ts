export interface Env {
    L_MESSAGE_WEBHOOK_URL: string;
    MY_APP_WEBHOOK_URL: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // POSTメソッド以外は405 Method Not Allowed
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        // Webhook URLが設定されているか確認
        if (!env.L_MESSAGE_WEBHOOK_URL && !env.MY_APP_WEBHOOK_URL) {
            console.error('Webhook URLs are not configured.');
            return new Response('Configuration Error', { status: 500 });
        }

        try {
            // リクエストボディの取得（一度しか読めないのでテキストとして取得して再利用）
            const bodyText = await request.text();

            // 署名の取得
            const signature = request.headers.get('x-line-signature');
            const headers: HeadersInit = {
                'Content-Type': 'application/json',
            };
            if (signature) {
                headers['x-line-signature'] = signature;
            }

            // 転送処理を定義（非同期）
            const forward = async (url: string, name: string) => {
                if (!url) return;
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: headers,
                        body: bodyText,
                    });
                    console.log(`[${name}] Forwarded: ${response.status}`);
                    if (!response.ok) {
                        console.error(`[${name}] Error response: ${await response.text()}`);
                    }
                } catch (error) {
                    console.error(`[${name}] Failed to forward:`, error);
                }
            };

            // バックグラウンドで転送を実行（レスポンスをブロックしない）
            ctx.waitUntil(
                Promise.allSettled([
                    forward(env.L_MESSAGE_WEBHOOK_URL, 'L-Message'),
                    forward(env.MY_APP_WEBHOOK_URL, 'My-App'),
                ])
            );

            // LINEサーバーには即座に200 OKを返す
            return new Response('OK', { status: 200 });

        } catch (error) {
            console.error('Error processing webhook:', error);
            return new Response('Internal Server Error', { status: 500 });
        }
    },
};
