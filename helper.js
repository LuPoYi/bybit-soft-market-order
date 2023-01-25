const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const placeOrReplaceOrder = async ({
  client,
  orderId,
  symbol,
  price,
  side,
  size,
}) => {
  let newOrderId
  if (orderId) {
    const { ret_msg, result } = await client.replaceActiveOrder({
      order_id: orderId,
      symbol: symbol,
      p_r_price: price,
    })
    if (ret_msg !== "OK") console.log("[Error!]", ret_msg, result)

    newOrderId = result.orderId
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
    if (ret_msg !== "OK") console.log("[Error!]", ret_msg, result)

    newOrderId = result.orderId
  }

  return newOrderId
}

const getActiveOrderIdAndPrice = async ({ client, symbol }) => {
  const { result } = await client.getActiveOrderList({
    symbol: symbol,
    order_status: "New",
  })

  return {
    orderId: result?.data?.[0]?.order_id,
    price: result?.data?.[0]?.price,
  }
}

module.exports = {
  placeOrReplaceOrder,
  getActiveOrderIdAndPrice,
  sleep,
}
