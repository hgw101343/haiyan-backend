const express = require('express')
const router = express.Router()
const axios = require('axios')
const crypto = require('crypto')
const xml2js = require('xml2js')
const prisma = require('../lib/prisma')
const { authenticate } = require('../middlewares/auth')

/**
 * 生成微信支付签名（V2 版本，适合小程序支付）
 */
function generateSign(params, key) {
  const sortedKeys = Object.keys(params).sort()
  const signStr = sortedKeys
    .filter(k => params[k] !== '' && params[k] !== undefined && k !== 'sign')
    .map(k => `${k}=${params[k]}`)
    .join('&') + `&key=${key}`
  return crypto.createHash('md5').update(signStr).digest('hex').toUpperCase()
}

/**
 * 构建 XML 字符串
 */
function buildXML(params) {
  let xml = '<xml>'
  for (const [key, val] of Object.entries(params)) {
    xml += `<${key}><![CDATA[${val}]]></${key}>`
  }
  xml += '</xml>'
  return xml
}

/**
 * POST /api/payment/prepay
 * 微信小程序支付 —— 统一下单，返回 prepayId
 */
router.post('/prepay', authenticate, async (req, res) => {
  try {
    const { orderId } = req.body
    const order = await prisma.order.findFirst({
      where: { id: parseInt(orderId), userId: req.user.id, status: 'PENDING' }
    })
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在或已支付' })
    }

    const nonceStr = crypto.randomBytes(16).toString('hex')
    const timestamp = Math.floor(Date.now() / 1000).toString()

    // 统一下单参数
    const params = {
      appid: process.env.WECHAT_APPID,
      mch_id: process.env.WECHAT_PAY_MCHID,
      nonce_str: nonceStr,
      body: '点餐订单',
      out_trade_no: order.orderNo,
      total_fee: Math.round(parseFloat(order.totalAmount) * 100), // 单位：分
      spbill_create_ip: req.ip || '127.0.0.1',
      notify_url: process.env.WECHAT_PAY_NOTIFY_URL,
      trade_type: 'JSAPI',
      openid: req.user.openid
    }
    params.sign = generateSign(params, process.env.WECHAT_PAY_KEY)

    const xmlBody = buildXML(params)

    // 请求微信统一下单接口
    const wxRes = await axios.post(
      'https://api.mch.weixin.qq.com/pay/unifiedorder',
      xmlBody,
      { headers: { 'Content-Type': 'text/xml' } }
    )

    const parsed = await xml2js.parseStringPromise(wxRes.data, { explicitArray: false })
    const result = parsed.xml

    if (result.return_code !== 'SUCCESS' || result.result_code !== 'SUCCESS') {
      console.error('微信统一下单失败:', result)
      return res.status(400).json({ success: false, message: result.err_code_des || '支付发起失败' })
    }

    const prepayId = result.prepay_id

    // 保存 prepay_id
    await prisma.order.update({
      where: { id: order.id },
      data: { prepayId }
    })

    // 返回给小程序的支付参数（需再次签名）
    const payParams = {
      appId: process.env.WECHAT_APPID,
      timeStamp: timestamp,
      nonceStr,
      package: `prepay_id=${prepayId}`,
      signType: 'MD5'
    }
    payParams.paySign = generateSign(payParams, process.env.WECHAT_PAY_KEY)

    res.json({ success: true, data: payParams })
  } catch (err) {
    console.error('支付错误:', err)
    res.status(500).json({ success: false, message: '发起支付失败' })
  }
})

/**
 * POST /api/payment/notify
 * 微信支付回调通知
 */
router.post('/notify', express.text({ type: 'text/xml' }), async (req, res) => {
  try {
    const parsed = await xml2js.parseStringPromise(req.body, { explicitArray: false })
    const data = parsed.xml

    // 验证签名
    const sign = data.sign
    delete data.sign
    const expectedSign = generateSign(data, process.env.WECHAT_PAY_KEY)
    if (sign !== expectedSign) {
      console.error('支付回调签名验证失败')
      return res.send('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[签名错误]]></return_msg></xml>')
    }

    if (data.return_code === 'SUCCESS' && data.result_code === 'SUCCESS') {
      const orderNo = data.out_trade_no
      const transactionId = data.transaction_id

      const order = await prisma.order.findUnique({ where: { orderNo } })
      if (order && order.status === 'PENDING') {
        await prisma.order.update({
          where: { orderNo },
          data: { status: 'PAID', transactionId, paidAt: new Date() }
        })
        console.log(`订单 ${orderNo} 支付成功`)
      }
    }

    res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>')
  } catch (err) {
    console.error('支付回调处理失败:', err)
    res.send('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[处理失败]]></return_msg></xml>')
  }
})

/**
 * GET /api/payment/status/:orderNo
 * 主动查询支付状态
 */
router.get('/status/:orderNo', authenticate, async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { orderNo: req.params.orderNo, userId: req.user.id }
    })
    if (!order) return res.status(404).json({ success: false, message: '订单不存在' })
    res.json({ success: true, data: { status: order.status, paidAt: order.paidAt } })
  } catch (err) {
    res.status(500).json({ success: false, message: '查询失败' })
  }
})

module.exports = router
