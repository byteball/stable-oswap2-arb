# Arbitrage AA and bot for arbitraging between Ostable, Oswap v2, and Oswap v1

Two Autonomous Agents that make arbitrage trades between ostable, oswap v2, and oswap v1:

## 1. Arbitrage AA for arbitraging between Ostable and two Oswap v2 pools

This Autonomous Agent seeks opportunities to make profit by trading between [Ostable](https://ostable.org) and two [Oswap v2](https://v2.oswap.io) pools that make a circle, e.g.
* GBYTE -> OUSD on Ostable
* OUSD -> USDC on Oswap v2
* USDC -> GBYTE on Oswap v2

or the same circle in the opposite direction.

The AA trades only if it gets more GBYTE in the final trade than it sent in the first one.

## 2. Arbitrage AA for arbitraging between Ostwap v1 and Oswap v2

This Autonomous Agent seeks opportunities to make profit by trading between [Oswap v1](https://oswap.io) and [Oswap v2](https://v2.oswap.io) pools having the same pairs, e.g.
* Buy GBYTE in oswap v1 GBYTE-USDC pool if GBYTE is cheaper in v1 than in v2
* Sell GBYTE in oswap v2 GBYTE-USDC pool


# Bot

The companion bot watches the markets and triggers one of these AAs when it sees an arbitrage opportunity.

## Usage

The base AAs are already deployed (see their addresses by opening `arb-ostable-oswap.oscript` and `arb-oswap-v1-v2.oscript` in VS Code with [Oscript plugin](https://marketplace.visualstudio.com/items?itemName=obyte.oscript-vscode-plugin)), deploy your personal arbitrage AA by indicating your address in the `owner` field of your `conf.json` and running
```bash
node deploy.js
```
Edit the `deploy.js` script to indicate which pairs or triangles you want to arbitrage.

Run the bot:
```bash
node run.js stable-oswap2-arb 2>errlog
```

Add some money to your arb AA and a small amount (for network fees) to the bot's balance.


### Run tests
```bash
yarn test
```

