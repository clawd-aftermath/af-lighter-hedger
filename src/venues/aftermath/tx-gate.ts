import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import {
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
} from "@mysten/sui/utils";
import { InvariantError } from "../../core/errors";
import type { GasMode } from "./types";

// Exact helpers used by native builders; never grant a blanket stdlib allowlist.
export const STDLIB_MOVE_CALLS = [
  "0x1::option::none",
  "0x1::option::some",
] as const;
const stdlibTargets = new Set(
  STDLIB_MOVE_CALLS.map((target) => {
    const [pkg, module, fn] = target.split("::");
    return `${normalizeSuiAddress(pkg ?? "")}::${module}::${fn}`;
  }),
);
function stdlibCall(call: {
  package: string;
  module: string;
  function: string;
}): boolean {
  return stdlibTargets.has(
    `${address(call.package)}::${call.module}::${call.function}`,
  );
}
export interface GateOptions {
  agentAddress: string;
  allowedPackageIds: readonly string[];
  mode: GasMode;
  referenceGasPrice: bigint;
  maxGasBudget: bigint;
  gasPoolPackageId?: string;
  dynamicGas?: DynamicGasPolicy;
  // Kind has no sender or gas data. The executor supplies these only after
  // setting them locally; full TransactionData is always checked again.
  kindContext?: { sender: string; gasPrice: bigint };
  takesLiquidity?: boolean;
}
function deny(message: string): never {
  throw new InvariantError(`Aftermath transaction gate: ${message}`);
}
function address(a: string): string {
  return normalizeSuiAddress(a);
}
function canonical(bytes: Uint8Array, encoded: Uint8Array): void {
  if (bytes.length !== encoded.length || bytes.some((b, i) => b !== encoded[i]))
    deny("noncanonical or trailing transaction bytes");
}
type TxData = ReturnType<Transaction["getData"]>;
type WireArgument = NonNullable<
  TxData["commands"][number]["TransferObjects"]
>["address"];
export interface VerifiedDynamicGasCoin {
  objectId: string;
  version: string;
  digest: string;
  owner: string;
  objectType: string;
}
export interface DynamicGasPolicy {
  originalTransaction: string;
  gasCoinType: string;
  maxDynamicGasFeeAtomic: bigint;
  // Independent gRPC object metadata, never taken from the sponsorship response.
  coin?: VerifiedDynamicGasCoin;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function originalData(json: string): TxData {
  try {
    return Transaction.from(json).getData();
  } catch {
    deny("invalid original transaction JSON");
  }
}
// The coin branch needs one independent ownership/type read. Geometry and
// unchanged-prefix checks are still performed by the pure gate before signing.
export function dynamicGasCoinReference(
  bytes: Uint8Array,
  originalTransaction: string,
): { objectId: string; version: string; digest: string } | undefined {
  const returned = Transaction.from(bytes).getData();
  const original = originalData(originalTransaction);
  const split = returned.commands[original.commands.length]?.SplitCoins;
  if (split?.coin.$kind !== "Input") return undefined;
  const ref = returned.inputs[split.coin.Input]?.Object?.ImmOrOwnedObject;
  return ref ? { ...ref, version: String(ref.version) } : undefined;
}
function validateDynamicGas(data: TxData, options: GateOptions): number {
  const policy = options.dynamicGas;
  if (
    !policy ||
    typeof policy.maxDynamicGasFeeAtomic !== "bigint" ||
    policy.maxDynamicGasFeeAtomic < 0n
  )
    deny("dynamic-gas original transaction and fee cap required");
  const maxFee = policy.maxDynamicGasFeeAtomic;
  let coinType: string;
  try {
    coinType = normalizeStructTag(policy.gasCoinType);
  } catch {
    deny("invalid dynamic gas coin type");
  }
  const original = originalData(policy.originalTransaction);
  if (
    !original.sender ||
    address(original.sender) !== address(options.agentAddress)
  )
    deny("wrong original sender");
  const start = original.commands.length;
  if (
    data.inputs.length < original.inputs.length ||
    data.commands.length <= start ||
    stable(data.inputs.slice(0, original.inputs.length)) !==
      stable(original.inputs) ||
    stable(data.commands.slice(0, start)) !== stable(original.commands)
  )
    deny("dynamic-gas original inputs or commands changed");
  const suffix = data.commands.slice(start);
  const used = new Set<number>();
  function input(arg: WireArgument | undefined) {
    if (!arg || arg.$kind !== "Input")
      deny("reimbursement requires an input argument");
    used.add(arg.Input);
    const value = data.inputs[arg.Input];
    if (!value) deny("reimbursement input missing");
    return value;
  }
  function fee(arg: WireArgument | undefined): bigint {
    const value = input(arg);
    if (value.$kind !== "Pure") deny("reimbursement fee must be pure u64");
    const bytes = fromBase64(value.Pure.bytes);
    if (bytes.length !== 8) deny("reimbursement fee must be u64");
    return bounded(BigInt(bcs.U64.parse(bytes)));
  }
  function bounded(amount: bigint): bigint {
    if (amount < 0n || amount > maxFee) deny("dynamic gas fee exceeds cap");
    return amount;
  }
  function result(arg: WireArgument | undefined, index: number): boolean {
    if (!arg) return false;
    return arg.$kind === "Result"
      ? arg.Result === index
      : arg.$kind === "NestedResult" &&
          arg.NestedResult[0] === index &&
          arg.NestedResult[1] === 0;
  }
  let transferIndex: number;
  let coinResultIndex: number;
  const first = suffix[0];
  if (first?.$kind === "SplitCoins") {
    if (suffix.length !== 2 || first.SplitCoins.amounts.length !== 1)
      deny("invalid coin reimbursement suffix");
    const value = input(first.SplitCoins.coin);
    const ref = value.Object?.ImmOrOwnedObject;
    const proof = policy.coin;
    if (
      !ref ||
      !proof ||
      address(ref.objectId) !== address(proof.objectId) ||
      String(ref.version) !== proof.version ||
      ref.digest !== proof.digest ||
      address(proof.owner) !== address(options.agentAddress)
    )
      deny("reimbursement coin ownership/reference not verified");
    let type: string;
    try {
      type = normalizeStructTag(proof.objectType);
    } catch {
      deny("invalid reimbursement coin object type");
    }
    if (type !== normalizeStructTag(`0x2::coin::Coin<${coinType}>`))
      deny("reimbursement coin type mismatch");
    fee(first.SplitCoins.amounts[0]);
    coinResultIndex = start;
    transferIndex = start + 1;
  } else if (first?.$kind === "MoveCall") {
    const call = first.MoveCall;
    if (
      address(call.package) !== address("0x2") ||
      call.module !== "coin" ||
      call.function !== "redeem_funds" ||
      call.typeArguments.length !== 1 ||
      call.arguments.length !== 1
    )
      deny("invalid address-balance reimbursement call");
    try {
      if (normalizeStructTag(call.typeArguments[0] ?? "") !== coinType)
        deny("reimbursement withdrawal type mismatch");
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      deny("invalid withdrawal type");
    }
    const value = input(call.arguments[0]);
    const withdrawal = value.FundsWithdrawal;
    if (
      !withdrawal ||
      withdrawal.withdrawFrom.$kind !== "Sender" ||
      withdrawal.typeArg.$kind !== "Balance" ||
      withdrawal.reservation.$kind !== "MaxAmountU64"
    )
      deny("reimbursement withdrawal must debit sender");
    try {
      if (normalizeStructTag(withdrawal.typeArg.Balance) !== coinType)
        deny("reimbursement withdrawal type mismatch");
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      deny("invalid withdrawal type");
    }
    const reserved = bounded(BigInt(withdrawal.reservation.MaxAmountU64));
    if (suffix[1]?.$kind === "SplitCoins") {
      const split = suffix[1].SplitCoins;
      if (
        suffix.length !== 3 ||
        !result(split.coin, start) ||
        split.amounts.length !== 1
      )
        deny("invalid withdrawal split");
      if (fee(split.amounts[0]) > reserved)
        deny("withdrawal split exceeds reservation");
      coinResultIndex = start + 1;
      transferIndex = start + 2;
    } else {
      if (suffix.length !== 2)
        deny("invalid address-balance reimbursement suffix");
      coinResultIndex = start;
      transferIndex = start + 1;
    }
  } else deny("missing dynamic gas reimbursement suffix");
  const transfer = data.commands[transferIndex]?.TransferObjects;
  if (
    !transfer ||
    transfer.objects.length !== 1 ||
    !result(transfer.objects[0], coinResultIndex)
  )
    deny("reimbursement must transfer only its coin result");
  const recipientInput = input(transfer.address);
  if (recipientInput.$kind !== "Pure")
    deny("reimbursement recipient must be pure address");
  const recipientBytes = fromBase64(recipientInput.Pure.bytes);
  if (recipientBytes.length !== 32) deny("invalid reimbursement recipient");
  const recipient = address(bcs.Address.parse(recipientBytes));
  if (
    !data.gasData.owner ||
    recipient !== address(data.gasData.owner) ||
    recipient === address(options.agentAddress)
  )
    deny("reimbursement recipient must equal non-agent gas owner");
  for (let i = original.inputs.length; i < data.inputs.length; i++)
    if (!used.has(i)) deny("extra dynamic gas input");
  return start;
}
export function gateTransaction(
  bytes: Uint8Array,
  format: "kind" | "data",
  options: GateOptions,
): void {
  let tx: Transaction;
  try {
    if (format === "kind") {
      const kind = bcs.TransactionKind.parse(bytes);
      if (kind.$kind !== "ProgrammableTransaction")
        deny("unsupported transaction kind");
      canonical(bytes, bcs.TransactionKind.serialize(kind).toBytes());
      tx = Transaction.fromKind(bytes);
    } else {
      const data = bcs.TransactionData.parse(bytes);
      if (data.V1?.kind.$kind !== "ProgrammableTransaction")
        deny("unsupported transaction data");
      canonical(bytes, bcs.TransactionData.serialize(data).toBytes());
      tx = Transaction.from(bytes);
    }
  } catch (e) {
    if (e instanceof InvariantError) throw e;
    deny("invalid BCS transaction");
  }
  const data = tx.getData();
  const sender = format === "data" ? data.sender : options.kindContext?.sender;
  if (!sender || address(sender) !== address(options.agentAddress))
    deny("wrong sender");
  const price =
    format === "data"
      ? data.gasData.price && BigInt(data.gasData.price)
      : options.kindContext?.gasPrice;
  if (options.referenceGasPrice <= 0n || options.maxGasBudget <= 0n)
    deny("invalid gas policy");
  if (format === "data") {
    const gas = data.gasData;
    if (
      !gas.budget ||
      BigInt(gas.budget) <= 0n ||
      BigInt(gas.budget) > options.maxGasBudget
    )
      deny("gas budget exceeds cap or is missing");
    if (!gas.owner) deny("missing gas owner");
    const sameOwner = address(gas.owner) === address(options.agentAddress);
    if (options.mode === "sui" ? !sameOwner : sameOwner)
      deny("wrong gas owner for gas mode");
  } else if (options.mode !== "sui")
    deny("sponsored transaction must be full TransactionData");
  if (
    options.gasPoolPackageId &&
    [address("0x1"), address("0x2")].includes(address(options.gasPoolPackageId))
  )
    deny("gas-pool package cannot be stdlib or framework");
  const suffixStart =
    options.mode === "dynamic-gas"
      ? validateDynamicGas(data, options)
      : data.commands.length;
  const packages = new Set(options.allowedPackageIds.map(address));
  if (packages.size === 0) deny("empty package allowlist");
  let rebates = 0;
  let canTakeLiquidity = options.takesLiquidity ?? true;
  for (const [index, command] of data.commands.entries()) {
    if (index >= suffixStart) continue; // Already validated the entire reimbursement suffix.
    switch (command.$kind) {
      case "MoveCall": {
        const call = command.MoveCall;
        const pool =
          options.gasPoolPackageId &&
          address(call.package) === address(options.gasPoolPackageId);
        if (pool) {
          if (
            options.mode !== "gas-pool" ||
            call.module !== "gas_pool" ||
            call.function !== "rebate_sponsor" ||
            index !== data.commands.length - 1 ||
            ++rebates !== 1
          )
            deny("unexpected gas-pool command");
        } else {
          if (
            !stdlibCall(call) &&
            (address(call.package) === address("0x1") ||
              address(call.package) === address("0x2") ||
              !packages.has(address(call.package)))
          )
            deny("MoveCall package outside allowlist");
          if (/place_.*order/.test(call.function)) canTakeLiquidity = true;
        }
        break;
      }
      case "TransferObjects": {
        const arg = command.TransferObjects.address;
        if (arg.$kind !== "Input")
          deny("transfer recipient is not a pure address");
        const input = data.inputs[arg.Input];
        if (input?.$kind !== "Pure") deny("transfer recipient is not pure");
        let recipient: string;
        try {
          recipient = bcs.Address.parse(fromBase64(input.Pure.bytes));
        } catch {
          deny("invalid transfer recipient");
        }
        if (address(recipient) !== address(options.agentAddress))
          deny("foreign transfer recipient");
        break;
      }
      case "SplitCoins":
      case "MergeCoins":
      case "MakeMoveVec":
        break;
      default:
        deny(`unsupported command ${command.$kind}`);
    }
  }
  if (options.mode === "gas-pool" && rebates !== 1)
    deny("gas-pool requires exactly one trailing rebate_sponsor");
  // Conservatively enforce RGP for every decoded order-placement call,
  // including post-only. Never trust a caller's post-only claim over the PTB.
  if (canTakeLiquidity && price !== options.referenceGasPrice)
    deny("liquidity-taking transaction gas price differs from reference");
}
