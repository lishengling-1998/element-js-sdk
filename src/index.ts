import { getChainId } from './util/chainUtil'
import {
  postBatchSignedERC721SellOrder,
  postOrder,
  queryExchangeData,
  queryFees,
  queryNonce,
  queryOrders,
  queryTradeData
} from './api/openApi'
import { TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider'
import {
  Asset,
  AssetSchema,
  BatchBuyWithETHParams,
  CancelAllOrdersByMakerParams,
  CancelOrderParams,
  CancelOrdersParams,
  CancelOrdersResponse,
  CancelOrdersTransaction,
  ElementAPIConfig,
  EncodeTradeDataParams,
  FailedERC721Item,
  FillOrderParams,
  MakeERC721SellOrdersParams,
  MakeERC721SellOrdersResponse,
  MakeOrderParams,
  NULL_ADDRESS,
  Order,
  OrderInformation,
  OrderSide,
  SaleKind,
  Standard,
  TradeData
} from './types/types'
import { LimitedCallSpec, Web3Signer } from './signer/Web3Signer'
import { BatchSignedOrderManager, getSucceedList } from './element/batchSignedOrder/batchSignedOrderManager'
import { OrderManager } from './element/order/orderManager'
import { ApiOption, OrderQuery } from './api/openApiTypes'
import { CreateOrderParams } from './element/order/orderTypes'
import { toOrderInformation, toOrderRequest } from './element/order/orderConverter'
import { toStandardERC20Token } from './util/tokenUtil'
import {
  cancelAllLooksRareOrders,
  cancelAllSeaportOrders,
  cancelLooksRareOrders,
  cancelSeaportOrders
} from './others/cancelOrder'
import { toNumber, toString } from './util/numberUtil'
import { getBoughtAssets } from './util/receiptUtil'
import { BigNumber } from 'ethers'

export class ElementSDK {
  public chainId: number
  public apiOption: ApiOption
  public web3Signer: Web3Signer
  public batchOrderManager: BatchSignedOrderManager
  public orderManager: OrderManager
  public isTestnet: boolean = false

  constructor(config: ElementAPIConfig) {
    if (config.isTestnet != null) {
      this.isTestnet = config.isTestnet
    }
    // this.chainId = getChainId(config.networkName, this.isTestnet)
    this.chainId = config.chainId
    this.apiOption = {
      chain: config.networkName,
      isTestnet: this.isTestnet,
      apiKey: config.apiKey
    }
    this.web3Signer = new Web3Signer(config.signer, this.chainId)
    this.batchOrderManager = new BatchSignedOrderManager(this.web3Signer, this.apiOption)
    this.orderManager = new OrderManager(this.web3Signer)
  }

  public async makeERC721SellOrders(params: MakeERC721SellOrdersParams): Promise<MakeERC721SellOrdersResponse> {
    let error
    const succeedList: OrderInformation[] = []
    const failedList: FailedERC721Item[] = []

    // 1. setApproveForAll
    const counter = await this.batchOrderManager.approveAndGetCounter(params)

    // 2. create orders
    const orders = await this.batchOrderManager.createOrders(params, counter)
    for (const order of orders) {
      try {
        // 3. sign order
        const signedOrder = await this.batchOrderManager.signOrder(order)

        // 4. post order
        const r = await postBatchSignedERC721SellOrder(signedOrder, this.apiOption)
        succeedList.push(...getSucceedList(signedOrder, r.successList))
        failedList.push(...r.failList)
      } catch (e) {
        error = e
      }
    }

    if (succeedList.length == 0 && failedList.length == 0) {
      throw error
    }
    return {
      succeedList: succeedList,
      failedList: failedList
    }
  }

  public async makeSellOrder(params: MakeOrderParams): Promise<OrderInformation> {
    if (params.assetId == null) {
      throw Error('createSellOrder failed, asset.id is undefined.')
    }

    if (
      (!params.assetSchema || params.assetSchema.toLowerCase() == 'erc721') &&
      (!params.takerAddress || params.takerAddress.toLowerCase() == NULL_ADDRESS)
    ) {
      const r = await this.makeERC721SellOrders({
        listingTime: params.listingTime,
        expirationTime: params.expirationTime,
        paymentToken: params.paymentToken,
        items: [
          {
            erc721TokenId: toString(params.assetId),
            erc721TokenAddress: params.assetAddress,
            paymentTokenAmount: toString(params.paymentTokenAmount)
          }
        ],
        gasPrice: params.gasPrice,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas
      })
      if (!r.succeedList?.length) {
        const e = r.failedList?.length ? r.failedList[0].errorDetail : ''
        throw Error('createSellOrder failed, ' + e)
      }
      return r.succeedList[0]
    }
    return await this.makeOrder(params, false)
  }

  public async makeBuyOrder(params: MakeOrderParams): Promise<OrderInformation> {
    return await this.makeOrder(params, true)
  }

  public async fillOrder(params: FillOrderParams): Promise<LimitedCallSpec> {
    if (params.order.standard?.toString().toLowerCase() != Standard.ElementEx) {
      if (toStandardERC20Token(params.order.paymentToken) != NULL_ADDRESS) {
        throw Error(
          `fillOrder failed, standard(${params.order.standard}) don't support paymentToken(${params.order.paymentToken}).`
        )
      }
      if (params.quantity) {
        throw Error(`fillOrder failed, standard(${params.order.standard}) don't support 'params.quantity'.`)
      }
      if (Number(params.order.side) != OrderSide.SellOrder) {
        throw Error(`fillOrder failed, standard(${params.order.standard}) only support 'SellOrder'.`)
      }
      return this.batchBuyWithETH({
        orders: [params.order],
        gasPrice: params.gasPrice,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas
      })
    }

    const account = await this.web3Signer.getCurrentAccount()
    const list = await queryExchangeData([params.order], this.apiOption)
    if (!list.length || !list[0].exchangeData) {
      throw Error('fillOrder failed, queryExchangeData error.')
    }

    const signedOrder = JSON.parse(list[0].exchangeData)
    if (Number(params.order.saleKind) == SaleKind.BatchSignedERC721Order) {
      return this.batchOrderManager.fillOrder(signedOrder, account, params)
    } else {
      signedOrder.saleKind = Number(params.order.saleKind)
      signedOrder.takerAddress = account
      signedOrder.quantity = params.quantity != null ? toString(params.quantity) : undefined
      signedOrder.assetId = params.assetId != null ? toString(params.assetId) : undefined
      if (Number(params.order.side) == OrderSide.BuyOrder) {
        const order = signedOrder.order
        if (order.erc1155TokenId) {
          order.erc1155TokenProperties = order.erc1155TokenProperties || []
          order.nftProperties = null
        } else {
          order.erc1155TokenProperties = null
          order.nftProperties = order.nftProperties || []
        }
      } else {
        const order = signedOrder.order
        order.erc1155TokenProperties = null
        order.nftProperties = null
      }
      return this.orderManager.fillOrder(signedOrder, params)
    }
  }

  public async batchBuyWithETH(params: BatchBuyWithETHParams): Promise<LimitedCallSpec> {
    this.checkSellOrdersParams('batchBuyWithETH', params.orders)
    const taker = await this.web3Signer.getCurrentAccount()
    const tradeData = await queryTradeData(taker, params.orders, this.apiOption)

    const call: LimitedCallSpec = {
      from: taker,
      to: tradeData.to,
      value: tradeData.value,
      data: tradeData.data,
      gasPrice: params.gasPrice,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      maxFeePerGas: params.maxFeePerGas
    }
    return call
  }

  public async encodeTradeData(params: EncodeTradeDataParams): Promise<TradeData> {
    this.checkSellOrdersParams('encodeTradeData', params.orders)

    let taker = params.taker
    if (taker == null || taker == '' || taker.toLowerCase() == NULL_ADDRESS) {
      taker = await this.web3Signer.getCurrentAccount()
    }
    const tradeData = await queryTradeData(taker, params.orders, this.apiOption)
    return {
      toContract: tradeData.to,
      payableValue: tradeData.value,
      data: tradeData.data,
      flags: tradeData.flags
    }
  }

  public getBoughtAssets(receipt: TransactionReceipt): Array<Asset> {
    return getBoughtAssets(receipt)
  }

  public async cancelOrder(params: CancelOrderParams): Promise<TransactionResponse> {
    const account = await this.web3Signer.getCurrentAccount()
    if (params.order?.maker?.toLowerCase() != account.toLowerCase()) {
      throw Error(`cancelOrder failed, account mismatch, order.maker(${params.order?.maker}), account(${account}).`)
    }

    const list = await queryExchangeData([params.order], this.apiOption)
    if (!list.length || !list[0].exchangeData) {
      throw Error('cancelOrder failed, queryExchangeData error.')
    }

    const signedOrder = JSON.parse(list[0].exchangeData)
    if (params.order.standard?.toString().toLowerCase() == Standard.ElementEx) {
      if (params.order.schema.toLowerCase() == AssetSchema.ERC721.toLowerCase()) {
        return this.orderManager.cancelERC721Orders([signedOrder], params)
      } else if (params.order.schema.toLowerCase() == AssetSchema.ERC1155.toLowerCase()) {
        return this.orderManager.cancelERC1155Orders([signedOrder], params)
      } else {
        throw Error('cancelOrder failed, unsupported schema : ' + params.order.schema)
      }
    } else if (params.order.standard?.toLowerCase() == Standard.Seaport) {
      return cancelSeaportOrders([signedOrder], this.web3Signer, params)
    } else if (params.order.standard?.toLowerCase() == Standard.LooksRare) {
      return cancelLooksRareOrders([signedOrder], this.web3Signer, params)
    } else {
      throw Error('cancelOrder failed, unsupported standard : ' + params.order.standard)
    }
  }

  public async cancelOrders(params: CancelOrdersParams): Promise<CancelOrdersResponse> {
    if (!params.orders?.length) {
      throw Error(`cancelOrders failed, orders?.length error.`)
    }

    const account = await this.web3Signer.getCurrentAccount()
    params.orders.forEach((value, index, array) => {
      if (account.toLowerCase() != value.maker?.toLowerCase()) {
        throw Error(
          `cancelOrders failed, account mismatch, index=(${index}), order.maker(${value.maker}), account(${account}).`
        )
      }
    })

    const list = await queryExchangeData(params.orders, this.apiOption)
    if (!list?.length) {
      throw Error('cancelOrders failed, queryExchangeData error.')
    }

    const elementERC721Orders: OrderInformation[] = []
    const elementERC1155Orders: OrderInformation[] = []
    const seaportOrders: OrderInformation[] = []
    const looksRareOrders: OrderInformation[] = []
    const elementERC721SignedOrders: any[] = []
    const elementERC1155SignedOrders: any[] = []
    const seaportSignedOrders: any[] = []
    const looksRareSignedOrders: any[] = []

    for (const order of list) {
      if (order.exchangeData && order.standard) {
        const signedOrder = JSON.parse(order.exchangeData)
        if (order.standard.toLowerCase() == Standard.ElementEx) {
          if (order.schema?.toLowerCase() == AssetSchema.ERC721.toLowerCase()) {
            elementERC721Orders.push(order)
            elementERC721SignedOrders.push(signedOrder)
          } else if (order.schema?.toLowerCase() == AssetSchema.ERC1155.toLowerCase()) {
            elementERC1155Orders.push(order)
            elementERC1155SignedOrders.push(signedOrder)
          }
        } else if (order.standard.toLowerCase() == Standard.Seaport) {
          seaportOrders.push(order)
          seaportSignedOrders.push(signedOrder)
        } else if (order.standard.toLowerCase() == Standard.LooksRare) {
          looksRareOrders.push(order)
          looksRareSignedOrders.push(signedOrder)
        }
      }
    }

    const succeedTransactions: Array<CancelOrdersTransaction> = []
    if (elementERC721Orders.length > 0) {
      const tx = await this.orderManager.cancelERC721Orders(elementERC721SignedOrders, params)
      succeedTransactions.push({
        orders: elementERC721Orders,
        transaction: tx
      })
    }
    if (elementERC1155Orders.length > 0) {
      try {
        const tx = await this.orderManager.cancelERC1155Orders(elementERC1155SignedOrders, params)
        succeedTransactions.push({
          orders: elementERC1155Orders,
          transaction: tx
        })
      } catch (e) {
        if (succeedTransactions.length == 0) {
          throw e
        }
      }
    }
    if (seaportOrders.length > 0) {
      try {
        const tx = await cancelSeaportOrders(seaportSignedOrders, this.web3Signer, params)
        succeedTransactions.push({
          orders: seaportOrders,
          transaction: tx
        })
      } catch (e) {
        if (succeedTransactions.length == 0) {
          throw e
        }
      }
    }
    if (looksRareOrders.length > 0) {
      try {
        const tx = await cancelLooksRareOrders(looksRareSignedOrders, this.web3Signer, params)
        succeedTransactions.push({
          orders: looksRareOrders,
          transaction: tx
        })
      } catch (e) {
        if (succeedTransactions.length == 0) {
          throw e
        }
      }
    }
    if (succeedTransactions.length == 0) {
      throw Error('cancelOrders failed.')
    }
    return { succeedTransactions: succeedTransactions }
  }

  public async cancelAllOrdersForSigner(params?: CancelAllOrdersByMakerParams): Promise<TransactionResponse> {
    if (params?.standard?.toLowerCase() == Standard.Seaport) {
      return cancelAllSeaportOrders(this.web3Signer, params)
    } else if (params?.standard?.toLowerCase() == Standard.LooksRare) {
      return cancelAllLooksRareOrders(this.web3Signer, params)
    } else {
      return this.orderManager.cancelAllOrders(params)
    }
  }

  public async queryOrders(query: OrderQuery): Promise<Array<Order>> {
    return await queryOrders(query, this.apiOption)
  }

  private checkSellOrdersParams(tag: string, orders: Array<OrderInformation>) {
    if (!orders?.length) {
      throw Error(`${tag} failed, orders.length error.`)
    }

    const weth = this.orderManager.WETH.toLowerCase()
    for (const order of orders) {
      const paymentToken = order.paymentToken
      if (paymentToken != NULL_ADDRESS) {
        if (!(order.standard?.toString().toLowerCase() == Standard.LooksRare && paymentToken == weth)) {
          throw Error(`${tag} failed, paymentToken error, only support ETH.`)
        }
      }
      if (Number(order.side) != OrderSide.SellOrder) {
        throw Error(`${tag} failed, order.side error, only support SellOrder.`)
      }
    }
  }

  private async makeOrder(params: MakeOrderParams, isBuyOrder: boolean): Promise<OrderInformation> {
    const schema = params.assetSchema || AssetSchema.ERC721
    if (schema.toLowerCase() != 'erc721' && schema.toLowerCase() != 'erc1155') {
      throw Error('makeOrder failed, unsupported schema : ' + schema)
    }
    const assetId = toString(params.assetId) || undefined
    const accountAddress = await this.web3Signer.getCurrentAccount()
    const takerAddress = params.takerAddress ? params.takerAddress.toLowerCase() : NULL_ADDRESS

    // 1. query nonce
    const nonce = await queryNonce(
      {
        maker: accountAddress,
        schema: schema,
        count: 1
      },
      this.apiOption
    )

    // 2. queryFees
    let platformFeePoint, platformFeeAddress, royaltyFeePoint, royaltyFeeAddress
    if (takerAddress === NULL_ADDRESS) {
      const fees = await queryFees([params.assetAddress], this.apiOption)
      if (fees.length > 0) {
        platformFeePoint = fees[0].protocolFeePoints
        platformFeeAddress = fees[0].protocolFeeAddress
        royaltyFeePoint = fees[0].royaltyFeePoints
        royaltyFeeAddress = fees[0].royaltyFeeAddress
      }
    }

    // 3. create order
    const quantity = params.quantity != null ? toString(params.quantity) : undefined
    const orderParams: CreateOrderParams = {
      makerAddress: accountAddress,
      takerAddress,
      asset: {
        id: assetId,
        address: params.assetAddress,
        schema: schema.toString().toUpperCase()
      },
      quantity: quantity,
      paymentToken: params.paymentToken,
      startTokenAmount: toString(params.paymentTokenAmount),
      platformFeePoint: platformFeePoint,
      platformFeeAddress: platformFeeAddress,
      royaltyFeePoint: royaltyFeePoint,
      royaltyFeeAddress: royaltyFeeAddress,
      listingTime: toNumber(params.listingTime),
      expirationTime: toNumber(params.expirationTime),
      nonce: nonce.toString(),
      saleKind: SaleKind.FixedPrice
    }
    const order = isBuyOrder
      ? await this.orderManager.createBuyOrder(orderParams, params)
      : await this.orderManager.createSellOrder(orderParams, params)

    // 4. sign order
    const signedOrder = await this.orderManager.signOrder(order)

    // 5. post order
    const request = toOrderRequest(signedOrder)
    await postOrder(request, this.apiOption)

    if (
      schema.toLowerCase() == 'erc1155' &&
      !BigNumber.from(request.basePrice).div(request.quantity).mul(request.quantity).eq(request.basePrice)
    ) {
      try {
        const orders = await this.queryOrders({
          asset_contract_address: request.metadata.asset.address,
          token_ids: [request.metadata.asset.id],
          sale_kind: request.saleKind,
          listed_after: request.listingTime - 1,
          listed_before: request.listingTime + 1,
          maker: request.maker,
          taker: request.taker,
          side: request.side
        })
        if (orders?.length) {
          for (const o of orders) {
            if (o.listingTime == request.listingTime) {
              return o
            }
          }
        }
      } catch (e) {
        console.log(e)
      }
    }
    return toOrderInformation(request)
  }
}
