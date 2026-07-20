const { resolveArticleContent } = require('/Users/jinxin/ClawWorking/NewRSS/src/extractor');

const articleCookieHeader = `nyt-a=fMQRhknmEIBcny-JUs7UVw; nyt-gdpr=0; nyt-purr=cfhhcfhhhckfhcfshgas2fdnd; nyt-b-sid=55Jv1tH63Es-x3HNfndjjUPP; _gcl_au=1.1.151490922.1775785796; _twpid=tw.1775785796506.506100964245514323; _cb=TIT8U0rE5zBDvfUF; _pin_unauth=dWlkPVkyWTJZelptTkRjdFpXRmxNeTAwTkRNd0xXRTNPRGN0TkRBek1qUTNNVEpqWXpObA; _scid=0_BZwLK5ugYpKq1BfqXnKgoFFUU0C-MX; nyt-geo=TW; purr-pref-agent=<G_<C_<T0<Td_<Tp1_<Tp2_<Tp3_<Tp4_<Tp7_<a0_; gpp-string=\",,DBABLA~BVQqAAAAAABo.QA\"; _v__chartbeat3=DrKhgaDLzo3sCOOk4j; __gads=ID=4f48b66c3fabce28:T=1775785803:RT=1775785803:S=ALNI_MYBBOFycIlkSsSl7aeFdwTAsrTS-Q; __gpi=UID=00001245833a4a0b:T=1775785803:RT=1775785803:S=ALNI_MYxMjFPP31AdnCZLKxqIW_Ztasyrw; __eoi=ID=209cec4f4d3e5c05:T=1775785803:RT=1775785803:S=AA-AfjZJfG44DVczvbfOlj_jGQ70; g_state={\"i_l\":0,\"i_ll\":1775785809448,\"i_b\":\"3eABUr8BWv/vjETFeqNp+m2I8PijXXPv5E3SwPhCPHs\",\"i_e\":{\"enable_itp_optimization\":0}}; purr-cache=<G_<C_<T0<Td_<Tp1_<Tp2_<Tp3_<Tp4_<Tp7_<a0_<K0<r<ur; NYT-MPS=0000000c1cb4a5ad616e6aeae585a47bd8c8382b7a7324dd55dc2cf7c5c7a289256e2ad885ecd7d5085fed95108fa0ecb5eb21e29af8d84d16682a714b96; NYT-S=0^CB8SMQjfruHOBhDXr-HOBhoSMS32qN5O2tgicjEmEs5jNGkHILTtqB8qAh53OOK2__kEQgAaQLPbhYpu7mIlvwzpurP8bROUD4l5XBorXj_DN4mAT-aJiWkAUDtg2biMecK-X-SuEUaJL-T5YGot6P3PS-Zhtw8=; nyt-auth-method=username; _cb_svref=https%3A%2F%2Fmyaccount.nytimes.com%2F; _scid_r=7HBZwLK5ugYpKq1BfqXnKgoFFUU0C-MXOZ30aQ; mprtcl-v4_1B8936A3={'gs':{'ie':1|'dt':'us2-c3efe7d669fbdf44bc3dafeefdb64b38'|'cgid':'eef8c2d6-765e-41ff-b8b8-d47ef63b0438'|'das':'7b56addb-841e-42ef-7683-42370a6c168a'|'ssd':1775785825506|'csm':'WyItMTM4MTY5OTA0MTI0OTg2Mjg1MiJd'|'sid':'411AB78F-091C-4C10-AEE4-503A7CA0669A'|'les':1775785825513}|'l':0|'-1381699041249862852':{'fst':1775785826407}|'cu':'-1381699041249862852'}; _sctr=1%7C1775750400000; nyt-traceid=000000000000000009ade8420c05049f; nyt-jkidd=uid=65681076&lastRequest=1775785847564&activeDays=%5B0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C0%2C1%5D&adv=1&a7dv=1&a14dv=1&a21dv=1&lastKnownType=sub&newsStartDate=1775750006&entitlements=AAA+ATH+AUD+CKG+MM+MOW+MSD+MTD+WC+XWD; regi_cookie=regi_id=65681076; cto_bundle=pOjS_195blB5dkp0QWE0NG9EMEtvWlF3NSUyRkR6SHljSWpZMjQ1d2M5SEgxSVp6R2Y3R0R3TWslMkZHdVFVVkNvbDB3b1F1c3VEd1dTa0p3MmE2WGhrRXdYT2htOUwlMkJZUU1TYUtTVWx1cGMzTVlTd2VQNVZmMkpHM05LYk4lMkJJbE10YlhTbE1NUUF4OWMzWXVyNkVpOWFvV1R5ampvN1VNTXRFN0NYcFFySHRmMkklMkZUdXIwOTVjdmd0TWRCdmd3V2lsY2d6cEdp; cto_bidid=YKI9B182dTMwSyUyRiUyRmxnZ3ExZTZ1NmVvcE5pRDdHTnlPSHUwemxJRVpvemwxZU9xaE9NSGdaUVM3cEY0aSUyQlJpNzRrclc0MEtlcGNBcVZ3UkZST1RrVkpEVm01OEExUzhsUyUyQkhtSXlQUDZUOGZPQlFITEdvNHhIdm1CM05iZ2tvUDRNWlR5U2wyRFdRVGJJYnJNdkJtU2ZxdjFHZyUzRCUzRA; _chartbeat2=.1775785796969.1775785852462.1.8qELuBWSGxRDEc1jLhWAI-D-LFXw.2; iter_id=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhaWQiOiI2OTgyZGJkYjY0ZTAxZDFmMWNiN2YxYWQiLCJhaWRfZXh0Ijp0cnVlLCJjb21wYW55X2lkIjoiNWMwOThiM2QxNjU0YzEwMDAxMmM2OGY5IiwiaWF0IjoxNzc1Nzg1ODU3fQ.aTkT1kooItkwAKEnJLeyrfLrf4HhcRHMA4VpiotxyOw; datadome=AmdcWzKrW9yqjcqrVIKjQHMrdFUGCw_Sk6iZZFVcHJ5y6V0y1eilsh4ktNjfgnn33c4xrtH8Db7ErPbLSk1e3zRsFqEpnjJ75gmz0pkOUFcLGJehLEZFfPHUe8Q7f7jj; _dd_s=aid=c621a242-9a87-482e-aa76-69b1bb6db93f&rum=0&expire=1775786939845; _chartbeat5=797|681|nytimes.com%2F|https%3A%2F%2Fwww.nytimes.com%2F2026%2F04%2F09%2Fus%2Fflorida-manatee-safety-tips.html|C9eEfUO088jClCWizDZaQB6C78TF5||c|CQsAVMWWM9fCouYaHIWQlcCOo9l7|nytimes.com||international`;

(async () => {
  try {
    const result = await resolveArticleContent(
      {
        link: 'https://www.nytimes.com/2026/04/08/business/bitcoin-satoshi-nakamoto-identity-adam-back.html?searchResultPosition=4',
        title: 'nyt test'
      },
      {
        timeoutMs: 20000,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
        articleCookieDomain: 'nytimes.com',
        articleCookieHeader,
        upstreamProxyUrl: '',
      }
    );
    console.log(JSON.stringify({ source: result.source, textLength: result.textLength, title: result.title }, null, 2));
  } catch (err) {
    console.error('ERROR:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
})();
