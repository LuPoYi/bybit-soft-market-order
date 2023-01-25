const { LinearClient } = require("bybit-api")
const { default: Decimal } = require("decimal.js")
const { apiKey, apiSecret, strategy, delayTime } = require("./config.json")
const {
  placeOrReplaceOrder,
  getActiveOrderIdAndPrice,
  sleep,
} = require("./helper")
const {
  symbol,
  isTriggerNow,
  isTrailingStop,
  baseTriggerPrice,
  trailValue,
  isReduceAll,
  reduceSize,
} = strategy

const client = new LinearClient({
  key: apiKey,
  secret: apiSecret,
  testnet: false,
})

let isPriceTriggered = isTriggerNow || false
let isDone = false
let closeSide, closeSize, expectSize, triggerPrice, closeOrderId, dPriceStep
let dOrderPrice = new Decimal(0) // 目前訂單價格
let dBestPrice = new Decimal(0) // 最佳價格(把價格擠到order最上方)

const init = async () => {
  const { result } = await client.getPosition({ symbol: symbol })
  const { size, side } = result.find(({ size }) => size > 0)
  if (!size) {
    console.log("[Done] size === 0")
    process.exit(0)
  }

  closeSize = isReduceAll ? size : reduceSize
  expectSize = isReduceAll ? 0 : size - reduceSize
  closeSide = side === "Buy" ? "Sell" : "Buy"

  const { result: symbolsResult } = await client.getSymbols()
  const symbolInfo = symbolsResult.find(({ name }) => name === symbol)
  dPriceStep = new Decimal(symbolInfo.price_filter.tick_size)

  if (isTrailingStop) {
    const { result } = await client.getTickers({ symbol: symbol })
    const price = result[0].last_price
    triggerPrice = closeSide === "Buy" ? price + trailValue : price - trailValue
  } else {
    triggerPrice = baseTriggerPrice
  }

  console.log("[Init]", symbol, closeSize, closeSide, triggerPrice)
}

const fetchBestPrice = async () => {
  if (isDone) {
    console.log("[Done]", "=>", dBestPrice)
    process.exit(0)
  }

  const { result } = await client.getTickers({ symbol: symbol })
  const {
    last_price: lastPrice,
    bid_price: bidPrice,
    ask_price: askPrice,
  } = result[0]
  const dHighestBid = new Decimal(bidPrice) // 最高掛單買單
  const dLowestAsk = new Decimal(askPrice) // 最低掛單賣單

  // Check trigger price update when isTrailingStop is true
  if (isTrailingStop) {
    if (closeSide === "Buy" && triggerPrice > lastPrice + trailValue) {
      triggerPrice = lastPrice + trailValue
      console.log("[PRICE]", triggerPrice)
    }
    if (closeSide === "Sell" && triggerPrice < lastPrice - trailValue) {
      triggerPrice = lastPrice - trailValue
      console.log("[PRICE]", triggerPrice)
    }
  }

  // Before trigger price
  if (!isPriceTriggered) {
    if (
      (closeSide === "Buy" && lastPrice >= triggerPrice) ||
      (closeSide === "Sell" && lastPrice <= triggerPrice)
    ) {
      console.log("[Trigger!]", closeSide, triggerPrice)
      isPriceTriggered = true
    } else {
      const trigger = parseFloat(triggerPrice).toFixed(4)
      const gap = parseFloat(Math.abs(lastPrice - triggerPrice)).toFixed(4)
      console.log("[SKIP]", lastPrice, "trigger", trigger, "gap", gap)
      return
    }
  }

  const { result: positionResult } = await client.getPosition({
    symbol: symbol,
  })
  const { size: positionSize } = positionResult.find(({ size }) => size > 0)
  if (!positionSize || (!isReduceAll && positionSize <= expectSize)) {
    isDone = true
    return
  }

  if (!isPriceTriggered) return

  // Execute place order (when price triggered)
  if (!closeOrderId) {
    const { orderId, price } = await getActiveOrderIdAndPrice({
      client,
      symbol,
    })
    if (orderId && price) {
      closeOrderId = orderId
      dOrderPrice = new Decimal(price)
      console.log("[ActiveOrder]", price, orderId)
    }
  }

  // Find best price
  if (closeSide === "Buy") {
    const dBetterPrice = dHighestBid.plus(dPriceStep)
    dBestPrice = dBetterPrice >= dLowestAsk ? dHighestBid : dBetterPrice
  }
  if (closeSide === "Sell") {
    const dBetterPrice = dLowestAsk.minus(dPriceStep)
    dBestPrice = dBetterPrice <= dHighestBid ? dLowestAsk : dBetterPrice
  }
  // price is the same, do nothing
  if (dOrderPrice.equals(dBestPrice)) return

  console.log("B", dHighestBid, "A", dLowestAsk, "P", dBestPrice, dOrderPrice)

  // Place order with best price
  const newOrderId = await placeOrReplaceOrder({
    client,
    orderId: closeOrderId,
    symbol,
    price: dBestPrice,
    side: closeSide,
    size: closeSize,
  })
  console.log("[Update!]", dOrderPrice, "=>", dBestPrice)

  dOrderPrice = dBestPrice
  closeOrderId = newOrderId
}

const main = async () => {
  await init()
  while (true) {
    await fetchBestPrice()
    await sleep(delayTime)
  }
}

main()
