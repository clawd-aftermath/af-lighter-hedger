// Public subscriptions only; no account access, signing, or submission.
import { AfHttp, parseAf } from "../src/venues/aftermath/http";
import { AfMarkets } from "../src/venues/aftermath/markets";
import { LighterRest } from "../src/venues/lighter/rest";
import { LighterWs } from "../src/venues/lighter/ws";
const durationMs = Math.max(120000, Number(process.env.PROBE_MS ?? 125000));
const symbols = ["BTC", "ETH", "SOL", "SUI"];
const af = new AfMarkets(new AfHttp({baseUrl:"https://aftermath.finance"}));
const lighter = new LighterRest({network:"mainnet"});
const [am, lm] = await Promise.all([af.markets(), lighter.orderBookDetails()]);
const ids = new Map(am.filter(m => symbols.includes(m.market.marketParams.baseAssetSymbol.replace(/USD$/, ""))).map(m => [m.market.objectId, m.market.marketParams.baseAssetSymbol.replace(/USD$/, "")]));
const rows = new Map<string, number[]>();
for (const symbol of symbols) for (const channel of ["orderbook", "topOfOrderbook", "market", "oracle", "order_book", "market_stats"]) rows.set(`${symbol}/${channel}`, []);
function record(symbol: string | undefined, channel: string) { if(symbol) rows.get(`${symbol}/${channel}`)?.push(Date.now()); }
const socket = new (WebSocket as unknown as new(url:string, opts:Bun.WebSocketOptions)=>WebSocket)("wss://aftermath.finance/api/perpetuals/ws/updates", {headers:{"User-Agent":"af-lighter-hedger-probe/1.0"}});
const samples: Record<string, unknown> = {};
socket.onopen = () => { for (const [id] of ids) for (const channel of ["orderbook", "topOfOrderbook", "market", "oracle"]) socket.send(JSON.stringify({action:"subscribe",subscriptionType:{[channel]:channel === "topOfOrderbook" ? {marketId:id,priceBucketSize:0.001,bucketsNumber:20} : {marketId:id}}})); };
socket.onmessage = event => {try {const frame = parseAf(String(event.data)) as Record<string, Record<string, unknown>>; for(const [channel,payload] of Object.entries(frame)) {record(ids.get(String(payload.marketId ?? payload.objectId)),channel); if(!samples[channel]) samples[channel] = payload;} }catch {/* Plain subscription acknowledgments. */}};
socket.onerror = () => console.error("AF public socket error");
const ws = new LighterWs({network:"mainnet",pingMs:10000,staleMs:300000});
for(const symbol of symbols) { const market = lm.find(m=>m.symbol===symbol && m.marketType==="perp"); if(!market) throw new Error(`Missing ${symbol}`); ws.subscribeBook(market.marketId); ws.subscribeMarketStats(market.marketId); }
ws.on("book", book=>record(lm.find(m=>m.marketId===book.marketId)?.symbol,"order_book"));
ws.on("marketStats", stat=>record(lm.find(m=>m.marketId===stat.marketId)?.symbol,"market_stats"));
ws.on("fault",error=>console.error(error.message));
ws.start();
await new Promise(resolve=>setTimeout(resolve,durationMs));
socket.close(); ws.stop();
const result: Record<string, unknown> = {durationMs};
for(const [key,times] of rows) {const intervals = times.slice(1).map((time,i)=>time-times[i]!).sort((a,b)=>a-b); const percentile=(p:number)=>intervals[Math.max(0,Math.ceil(intervals.length*p)-1)]??0; result[key]={count:times.length,p50:percentile(.5),p90:percentile(.9),p99:percentile(.99),max:intervals.at(-1)??0};}
await Bun.write(new URL("../test/fixtures/feed-cadence.json",import.meta.url),JSON.stringify(result,null,2)+"\n");
await Bun.write(`${process.env.TMPDIR ?? "/tmp"}/hedger-public-samples.json`,JSON.stringify(samples,(_,v)=>typeof v==="bigint"?v.toString():v,null,2));
console.log(JSON.stringify(result));
