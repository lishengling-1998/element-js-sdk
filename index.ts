export { ElementSDK } from './src/index'
export { ethers, providers, Signer, BigNumber } from 'ethers'
export type { TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider'

export type { OrderQuery } from './src/api/openApiTypes'
export { toOrderInformation, toOrderRequest } from './src/element/order/orderConverter'

export { getOrderTypedData } from './src/element/order/orderTypedData.ts'

export { NULL_ADDRESS, ETH_TOKEN_ADDRESS, Network, OrderSide, SaleKind, Standard, Market } from './src/types/types'

export type {
  SignerOrProvider,
  Asset,
  ElementAPIConfig,
  OrderInformation,
  Order,
  OrderDetail,
  GasParams,
  ERC721SellOrderItem,
  MakeERC721SellOrdersParams,
  FailedERC721Item,
  MakeERC721SellOrdersResponse,
  MakeOrderParams,
  FillOrderParams,
  BatchBuyWithETHParams,
  EncodeTradeDataParams,
  CancelOrderParams,
  CancelOrdersParams,
  CancelOrdersResponse,
  CancelAllOrdersByMakerParams
} from './src/types/types'

export { RPC_URLS } from './src/contracts/config'
export { getChain, getChainId } from './src/util/chainUtil'
export { encodeBatchSignedOrders } from './src/swap/encodeBatchSignedOrders'
export { Swap } from './src/swap/swap'
