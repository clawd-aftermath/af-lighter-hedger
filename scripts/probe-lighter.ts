// Manual, read-only probe. Never imported by tests; never calls sendTx.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { historyHourly, normalizeFunding } from "../src/venues/lighter/funding";
import { LighterRest } from "../src/venues/lighter/rest";
import { LighterWs } from "../src/venues/lighter/ws";

const fixtures = resolve(import.meta.dir,"../test/fixtures/lighter");
const record = process.argv.includes("--record");
const seconds = 30;
const rest = new LighterRest({network:"mainnet"});
const output: string[] = [];
function report(value: string): void { output.push(value); console.log(value); }
async function publicRead(path: string): Promise<string> {
  const response = await fetch(`${rest.profile.baseUrl}/api/v1/${path}`,{signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Public read failed: HTTP ${response.status}`);
  return response.text();
}
if (record) await mkdir(fixtures,{recursive:true});
const markets = await rest.orderBookDetails();
report(`Public mainnet probe ${new Date().toISOString()}; markets=${markets.length}`);
report("symbol market_id size_decimals price_decimals min_base min_quote");
for (const symbol of ["BTC","ETH","SOL","SUI"]) {
  const m = markets.find(m => m.symbol === symbol && m.marketType === "perp");
  if (!m) throw new Error(`Missing ${symbol} market`);
  report(`${m.symbol} ${m.marketId} ${m.sizeDecimals} ${m.priceDecimals} ${m.minBaseAmount} ${m.minQuoteAmount}`);
}
const btc = markets.find(m => m.symbol === "BTC" && m.marketType === "perp");
if (!btc) throw new Error("Missing BTC market");
const nowSeconds = Math.floor(Date.now()/1000);
const history = await rest.fundings(btc.marketId,nowSeconds-24*3600,nowSeconds,24);
const last = history.at(-1);
report(`BTC last history hourly=${last ? historyHourly(last) : "unknown"}`);
if (record) {
  // No accounts are queried. Public book owners are redacted from the fixture.
  await writeFile(resolve(fixtures,"markets.json"),await publicRead("orderBookDetails"));
  const book = JSON.parse(await publicRead(`orderBookOrders?market_id=${btc.marketId}&limit=5`));
  for (const side of ["asks","bids"]) for (const row of book[side]) delete row.owner_account_index;
  await writeFile(resolve(fixtures,"book.json"),JSON.stringify(book,null,2));
  await writeFile(resolve(fixtures,"fundings.json"),await publicRead(`fundings?market_id=${btc.marketId}&resolution=1h&start_timestamp=${nowSeconds-24*3600}&end_timestamp=${nowSeconds}&count_back=24`));
  await writeFile(resolve(fixtures,"funding-rates.json"),await publicRead("funding-rates"));
}
const frames: string[] = [];
const stats = new Map<number,ReturnType<typeof normalizeFunding>>();
let books = 0; let gaps = 0; let pongs = 0; let disconnects = 0; let faults = 0;
const ws = new LighterWs({network:"mainnet",pingMs:10000,staleMs:20000});
ws.subscribeBook(btc.marketId); ws.subscribeMarketStats("all");
ws.on("raw",frame => { if (record) frames.push(JSON.stringify(frame,(_,v) => typeof v === "bigint" ? v.toString() : v)); });
ws.on("book",() => books++);
ws.on("stale",e => { if (e.reason === "gap") gaps++; });
ws.on("marketStats",s => stats.set(s.marketId,normalizeFunding(s,markets.find(m => m.marketId === s.marketId))));
ws.on("pong",() => pongs++); ws.on("disconnected",() => disconnects++);
ws.on("fault",error => { faults++; report(error.message); });
ws.start();
await new Promise(r => setTimeout(r,seconds*1000));
ws.stop();
report("Funding (fraction of notional/hour): symbol predicted last baseline");
for (const m of markets.filter(m => m.marketType === "perp").sort((a,b) => a.symbol.localeCompare(b.symbol))) {
  const f = stats.get(m.marketId);
  report(`${m.symbol} ${f?.predictedHourly ?? "unknown"} ${f?.lastHourly ?? "unknown"} ${f?.interestBaseline ?? "unknown"}`);
}
report(`BTC book ${seconds}s: snapshots+deltas=${books}, gaps=${gaps}; ping/pong=${pongs}; disconnects=${disconnects}; faults=${faults}`);
report("Authenticated/account reads=0; transaction submissions=0");
if (record) {
  await writeFile(resolve(fixtures,"public-stream.ndjson"),`${frames.join("\n")}\n`);
  await writeFile(resolve(fixtures,"probe-output.txt"),`${output.join("\n")}\n`);
  await writeFile(resolve(fixtures,"provenance.json"),JSON.stringify({recordedAt:new Date().toISOString(),network:"mainnet",durationSeconds:seconds,channels:[`order_book/${btc.marketId}`,"market_stats/all"],publicEndpoints:["orderBookDetails","orderBookOrders","fundings","funding-rates"],redactions:["orderBookOrders.owner_account_index"],accountFixture:"synthetic; official account-1 schema, not live verified",docs:"https://apidocs.lighter.xyz/llms.txt",books,gaps,pongs,disconnects,faults},null,2));
}
if (!books || !stats.size || gaps || !pongs || faults || disconnects) process.exitCode=1;
