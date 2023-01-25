const { LinearClient } = require("bybit-api")
const { apiKey, apiSecret, strategy, delayTime } = require("./config.json")
const { default: Decimal } = require("decimal.js")
const { symbol, isTriggerNow, isTrailingStop, baseTriggerPrice, trailValue } =
  strategy
const client = new LinearClient({
  key: apiKey,
  secret: apiSecret,
  testnet: false,
})

let isPriceTriggered = isTriggerNow || false
let isDone = false
let closeSide = "Buy"
let closeSize
let dOrderPrice = new Decimal(0) // 目前訂單價格
let dPriceStep = new Decimal(0)
let dBestPrice = new Decimal(0) // 最佳價格(把價格擠到order最上方)
let triggerPrice
let closeOrderId

const init = async () => {
  const { result } = await client.getPosition({ symbol: symbol })
  const { size, side } = result.find(({ size }) => size > 0)

  if (!size) {
    console.log("size === 0")
    process.exit(0)
  }
  closeSize = size
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

  console.log("[Init]", symbol, size, side, closeSide, dPriceStep, triggerPrice)
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

  // When price triggered, do the place order part
  if (isPriceTriggered) {
    if (!closeOrderId) {
      // try to get exist order first
      const { result } = await client.getActiveOrderList({
        symbol: symbol,
        order_status: "New",
      })
      closeOrderId = result?.data?.[0]?.order_id

      if (closeOrderId) {
        dOrderPrice = new Decimal(result.data[0].price)
        console.log("[ActiveOrder]", dOrderPrice, closeOrderId)
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
    console.log("B", dHighestBid, "A", dLowestAsk, "P", dBestPrice, dOrderPrice)

    // price is the same, do nothing
    if (dOrderPrice.equals(dBestPrice)) return

    // Place order with best price
    const newOrderId = placeOrReplaceOrder({
      orderId: closeOrderId,
      symbol,
      price: dBestPrice,
      side: closeSide,
      size: closeSize,
    })

    dOrderPrice = dBestPrice
    closeOrderId = newOrderId
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const placeOrReplaceOrder = async ({ orderId, symbol, price, side, size }) => {
  let newOrderId
  if (orderId) {
    const { ret_msg, result } = await client.replaceActiveOrder({
      order_id: orderId,
      symbol: symbol,
      p_r_price: price,
    })

    newOrderId = result.orderId
    console.log("[Replace!]", price, newOrderId, ret_msg)
  } else {
    const { ret_msg, result } = await client.placeActiveOrder({
      side: side,
      symbol: symbol,
      order_type: "Limit",
      price: price,
      qty: size,
      time_in_force: "PostOnly",
      reduce_only: true,
      close_on_trigger: false,
      position_idx: 0,
    })
    newOrderId = result.orderId
    console.log("[Place!]", size, price, newOrderId, ret_msg)
  }

  return newOrderId
}

const main = async () => {
  await init()
  while (true) {
    await fetchBestPrice()
    await sleep(delayTime)
  }
}

main()
