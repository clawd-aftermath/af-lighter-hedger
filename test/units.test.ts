import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/core/errors";
import {
  AF_SCALE,
  afIntToDecimal,
  afPriceToInt,
  afSizeToInt,
  lighterFromInt,
  lighterToInt,
  parseBigIntN,
  parseIdString,
  toBigIntN,
  USDC_SCALE,
  usdcFromInt,
  usdcToInt,
} from "../src/core/units";
import markets from "./fixtures/markets-min.json";

describe("Aftermath units", () => {
  test("scale is 1e9", () => {
    expect(AF_SCALE).toBe(1_000_000_000n);
  });
  for (const market of markets.aftermath) {
    const tick = BigInt(market.tick);
    const lot = BigInt(market.lot);
    test(`${market.symbol} rounds bids down and asks up to tick`, () => {
      const down = afPriceToInt("82490.123456789123", tick, "down");
      const up = afPriceToInt("82490.123456789123", tick, "up");
      expect(down % tick).toBe(0n);
      expect(up - down).toBe(tick);
      expect(down).toBe(
        market.symbol === "BTC" ? 82490123000000n : 82490123450000n,
      );
    });
    test(`${market.symbol} floors sizes to lot`, () => {
      const x = afSizeToInt("0.0000123456789", lot);
      expect(x).toBe(market.symbol === "BTC" ? 12345n : 10000n);
      expect(x % lot).toBe(0n);
    });
    test(`${market.symbol} round trips exact ticks and lots`, () => {
      for (const x of [0n, tick, tick * 9007199254740993n]) {
        expect(afPriceToInt(afIntToDecimal(x), tick, "down")).toBe(x);
        expect(afPriceToInt(afIntToDecimal(x), tick, "up")).toBe(x);
      }
      expect(afSizeToInt(afIntToDecimal(lot * 123n), lot)).toBe(lot * 123n);
    });
  }
  test("rounds excess precision up even below one scaled unit", () => {
    expect(afPriceToInt("0.00000000001", 10000n, "up")).toBe(10000n);
    expect(afSizeToInt("0.00000000001", 1n)).toBe(0n);
  });
  test("rejects nonpositive tick and lot", () => {
    for (const step of [0n, -1n]) {
      expect(() => afPriceToInt("1", step, "down")).toThrow(ConfigError);
      expect(() => afSizeToInt("1", step)).toThrow(ConfigError);
    }
  });
  test("formats signed balances and trims zeros", () => {
    expect(afIntToDecimal(-1n)).toBe("-0.000000001");
    expect(afIntToDecimal(1230000000n)).toBe("1.23");
    expect(afIntToDecimal(0n)).toBe("0");
  });
});

describe("Lighter units", () => {
  for (const market of markets.lighter) {
    test(`${market.symbol} exact price and size scaling`, () => {
      expect(lighterToInt("123.456789", market.priceDecimals, "down")).toBe(
        market.symbol === "BTC"
          ? 1234n
          : market.symbol === "ETH"
            ? 12345n
            : 12345678n,
      );
      expect(lighterToInt("0.123456", market.sizeDecimals, "down")).toBe(
        market.symbol === "BTC" ? 12345n : market.symbol === "ETH" ? 1234n : 1n,
      );
    });
    test(`${market.symbol} price/size round trips beyond 2^53`, () => {
      for (const dp of [market.priceDecimals, market.sizeDecimals]) {
        for (const x of [0n, 1n, 900719925474099312345n, -123n]) {
          const decimal = lighterFromInt(x, dp);
          if (x < 0n) expect(decimal).toStartWith("-");
          else expect(lighterToInt(decimal, dp, "down")).toBe(x);
        }
      }
    });
  }
  test("rounding down, up, nearest and halfway up", () => {
    expect(lighterToInt("1.234", 2, "down")).toBe(123n);
    expect(lighterToInt("1.234", 2, "up")).toBe(124n);
    expect(lighterToInt("1.234", 2, "nearest")).toBe(123n);
    expect(lighterToInt("1.235", 2, "nearest")).toBe(124n);
    expect(lighterToInt("1.23", 2, "up")).toBe(123n);
  });
  test("zero decimals and leading zeros", () => {
    expect(lighterToInt("00012.5", 0, "nearest")).toBe(13n);
    expect(lighterFromInt(12n, 0)).toBe("12");
  });
  test("invalid decimal precision", () => {
    for (const dp of [-1, 1.5, NaN, Infinity, 256]) {
      expect(() => lighterToInt("1", dp, "down")).toThrow(ConfigError);
      expect(() => lighterFromInt(1n, dp)).toThrow(ConfigError);
    }
  });
  test("rejects negative and malformed decimals", () => {
    for (const x of [
      "-1",
      "-0",
      "+1",
      "1e3",
      "NaN",
      "Infinity",
      " 1",
      "1 ",
      "",
      ".1",
      "1.",
      "1.2.3",
      "0x10",
    ]) {
      expect(() => lighterToInt(x, 2, "down")).toThrow(ConfigError);
      expect(() => afSizeToInt(x, 1n)).toThrow(ConfigError);
    }
  });
  test("USDC collateral uses 6dp", () => {
    expect(USDC_SCALE).toBe(1000000n);
    expect(usdcToInt("123.4567899")).toBe(123456789n);
    expect(usdcToInt("123.4567899", "up")).toBe(123456790n);
    expect(usdcFromInt(-123456789n)).toBe("-123.456789");
    expect(usdcToInt(usdcFromInt(9007199254740993n))).toBe(9007199254740993n);
  });
});

describe("bigint transport and IDs", () => {
  test("accepts all specified integer representations", () => {
    for (const x of ["123n", "123", 123, 123n])
      expect(parseBigIntN(x)).toBe(123n);
    expect(parseBigIntN("-123n")).toBe(-123n);
    expect(toBigIntN(9007199254740993n)).toBe("9007199254740993n");
  });
  test("rejects unsafe numbers and other types", () => {
    for (const x of [
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      1.1,
      true,
      null,
      undefined,
      {},
      "1.0",
      " 1n",
      "1e3",
      "n",
    ]) {
      expect(() => parseBigIntN(x)).toThrow(ConfigError);
    }
  });
  test("IDs above 2^53 remain exact from strings", () => {
    expect(parseIdString("1152921504606846975")).toBe(1152921504606846975n);
    expect(parseIdString(9007199254740993n)).toBe(9007199254740993n);
    expect(parseIdString(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991n);
  });
  test("IDs reject unsafe numbers, signed strings and suffixes", () => {
    for (const x of [
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      -1n,
      "-1",
      "+1",
      "123n",
      "1.0",
    ]) {
      expect(() => parseIdString(x)).toThrow(ConfigError);
    }
  });
});
