async function fetchProfile(token, channelName) {
    const userId = 'U91879d392b6d8aeecbd6e8f23f376e24';
    const url = `https://api.line.me/v2/bot/profile/${userId}`;

    try {
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (res.ok) {
            const data = await res.json();
            console.log(`[SUCCESS] Channel: ${channelName}`);
            console.log(`Display Name: ${data.displayName}`);
            console.log(`Picture URL: ${data.pictureUrl}`);
            console.log(`Status Message: ${data.statusMessage}`);
        } else {
            const errorData = await res.json();
            console.log(`[FAILED] Channel: ${channelName} - Status: ${res.status}`);
            console.log(`Error:`, errorData);
        }
    } catch (err) {
        console.error(`[ERROR] Channel: ${channelName}`, err);
    }
}

async function main() {
    const tokens = [
        { name: 'ぶち癒やしフェスタin東京', token: '8DZ8LqmhCr0rQnOq0Cr4VrnGKxmZzc32+LpmqgYEd9DfNzmCxdp+zjOIJYTCrrunUZNm2O895883XP6x9oku3TwDYimGXKwqZ4IiL8DGHFzGEyrtBQDYHnNPu7gqWZe//3gVcvC7HShWMKw49L92QwdB04t89/1O/w1cDnyilFU=' },
        { name: '声紋分析コーチ　若林', token: 'nQqxAo8goTAkPUCBcQrAuXodOAec0Y3mACElSx4enKpyzcgpV5Tenc/PRfHy4mCqtRlnTMsWT6FiXqd/9cfdSAG60hnrE943xNgqpElxtWJotVgocmqyw8RbgIlWN7/CfaalFjWH2EroVojWEec0LgdB04t89/1O/w1cDnyilFU=' }
    ];

    for (const t of tokens) {
        await fetchProfile(t.token, t.name);
    }
}

main();
