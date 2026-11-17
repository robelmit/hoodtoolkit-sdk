/**
 * Pons V2 on Robinhood Chain: the addresses, event topics and function
 * selectors this package uses. Each selector and topic is the keccak-256 of
 * the signature beside it, and each was exercised against the live contracts.
 */

/** The V2 launch factory. It emits one `TokenLaunched` per launch and names the token's own curve contract. */
export const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';

export const PONS_CONTRACTS = Object.freeze({
  factory: PONS_FACTORY,
  launchAndBuyRouter: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  memeHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  launchLocker: '0x267444d099b10fb5ed7c3cc7b7c767adca574952',
  graduationExecutor: '0xc7819b64a1daecd7ec19856d026cb14efbd89046',
  feeEscrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
});

export const PONS_TOPICS = Object.freeze({
  /** `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)`, from the factory. */
  tokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  /** `CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)`, from a curve. */
  curveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  /** `CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)`, from a curve. */
  curveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  /** `CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)`, from a curve when it is swept. */
  curveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
  /** `LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)`, from the factory. */
  launchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  /** `PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)`, from the factory. */
  poolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
});

export const CURVE = Object.freeze({
  /** `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)` */
  buy: '0x59a87bc1',
  /** `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)` */
  sell: '0xd04c6983',
  /** The quote reserve the curve prices against. It includes the phantom reserve. */
  quoteReserve: '0x9da771f4',
  /** Quote actually paid in. This, over the threshold, is the progress. */
  realQuoteReserve: '0x4f1f58fd',
  tokenReserve: '0xcbcb3171',
  sellableTokens: '0x808bcddc',
  graduationThreshold: '0x8b0bc501',
  phantomQuote: '0xc57eadfc',
  feeBps: '0x24a9d853',
  creatorTaxBps: '0xc1bb8901',
  /** `currentSnipeTaxBps(address recipient)` */
  currentSnipeTaxBps: '0xd7e1ef39',
  pairToken: '0x3de35b79',
  token: '0xfc0c546a',
  graduated: '0xe7c2b772',
  readyToGraduate: '0xc68360a5',
});

export const FACTORY = Object.freeze({
  /** `getLaunchedToken(address token)` returns the launch's record. */
  getLaunchedToken: '0x3cf28b5a',
});

/** Every Pons token has 18 decimals and a fixed supply minted to its curve at launch. */
export const PONS_TOKEN_DECIMALS = 18;
export const BPS = 10_000n;
/** A buy always keeps at least this much of the spend for the curve, whatever the snipe tax says. */
export const MIN_NET_BPS = 100n;
