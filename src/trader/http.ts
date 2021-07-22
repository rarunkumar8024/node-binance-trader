import * as http from "http"
import express from "express"

import logger, { loggerOutput } from "../logger"
import env from "./env"
import { resetVirtualBalances, setVirtualWalletFunds, tradingMetaData} from "./trader"
import { Dictionary } from "ccxt"
import { BalanceHistory } from "./types/trader"
import BigNumber from "bignumber.js"
import { loadRecords } from "./apis/postgres"

enum Pages {
    TRADES = "Open Trades",
    STRATEGIES = "Strategies",
    VIRTUAL = "Virtual Balances",
    LOG_MEMORY = "Log (Since Restart)",
    LOG_DB = "Log (History)",
    TRANS_MEMORY = "Transactions (Since Restart)",
    TRANS_DB = "Transactions (History)",
    PNL = "Profit n Loss / Balance History"
}

const urls = {
    [Pages.TRADES]: "trades?",
    [Pages.STRATEGIES]: "strategies?",
    [Pages.VIRTUAL]: "virtual?",
    [Pages.LOG_MEMORY]: "log?",
    [Pages.LOG_DB]: "log?db=%d&", // Page number will be inserted as needed
    [Pages.TRANS_MEMORY]: "trans?",
    [Pages.TRANS_DB]: "trans?db=%d&", // Page number will be inserted as needed
    [Pages.PNL]: "pnl?",
}

export default function startWebserver(): http.Server {
    const webserver = express()
    webserver.get("/", (req, res) =>
        res.send("Node Binance Trader is running.")
    )
    // Allow user to see open trades
    webserver.get("/trades", (req, res) => {
        if (Authenticate(req, res)) res.send(HTMLTableFormat(Pages.TRADES, tradingMetaData.tradesOpen))
    })
    // Allow user to see configured strategies
    webserver.get("/strategies", (req, res) => {
        if (Authenticate(req, res)) res.send(HTMLTableFormat(Pages.STRATEGIES, Object.values(tradingMetaData.strategies)))
    })
    // Allow user to see, reset, and change virtual balances
    webserver.get("/virtual", (req, res) => {
        if (Authenticate(req, res)) {
            if (req.query.reset) {
                const value = new BigNumber(req.query.reset.toString())
                if (value.isGreaterThan(0)) {
                    setVirtualWalletFunds(value)
                } else if (req.query.reset.toString().toLowerCase() != "true") {
                    res.send("Invalid reset parameter.")
                    return
                }
                resetVirtualBalances()
                res.send("Virtual balances have been reset.")
            } else {
                res.send(HTMLFormat(Pages.VIRTUAL, tradingMetaData.virtualBalances))
            }
        } 
    })
    // Allow user to see in memory or database log
    webserver.get("/log", async (req, res) => {
        if (Authenticate(req, res)) {
            if (Object.keys(req.query).includes("db")) {
                let page = req.query.db ? Number.parseInt(req.query.db.toString()) : 1
                // Load the log from the database
                res.send(HTMLFormat(Pages.LOG_DB, (await loadRecords("log", page)).join("\r\n"), page+1))
            } else {
                // Use the memory log, exclude blank lines (i.e. the latest one)
                res.send(HTMLFormat(Pages.LOG_MEMORY, loggerOutput.filter(line => line).reverse().join("\r\n")))
            }
        }
    })
    // Allow user to see in memory or database transactions
    webserver.get("/trans", async (req, res) => {
        if (Authenticate(req, res)) {
            if (Object.keys(req.query).includes("db")) {
                let page = req.query.db ? Number.parseInt(req.query.db.toString()) : 1
                // Load the transactions from the database
                res.send(HTMLTableFormat(Pages.TRANS_DB, (await loadRecords("transaction", page)), page+1))
            } else {
                // Use the memory transactions
                res.send(HTMLTableFormat(Pages.TRANS_MEMORY, tradingMetaData.transactions.slice().reverse(), ))
            }
        }
    })
    // Allow user to see actual PnL and daily balances for the past year
    webserver.get("/pnl", (req, res) => {
        if (Authenticate(req, res)) {
            const pnl: Dictionary<Dictionary<{}>> = {}
            const now = new Date()
            for (let tradingType of Object.keys(tradingMetaData.balanceHistory)) {
                pnl[tradingType] = {}
                for (let coin of Object.keys(tradingMetaData.balanceHistory[tradingType])) {
                    pnl[tradingType][coin] = {
                        Today: PercentageChange(tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()))),
                        SevenDays: PercentageChange(tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-6))),
                        ThirtyDays: PercentageChange(tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-29))),
                        OneEightyDays: PercentageChange(tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-179))),
                        Total: PercentageChange(tradingMetaData.balanceHistory[tradingType][coin]),
                    }
                }
            }
            res.send(HTMLFormat(Pages.PNL, {"Profit and Loss": pnl, "Balance History": tradingMetaData.balanceHistory}))
        }
    })
    return webserver.listen(env().TRADER_PORT, () =>
        logger.info(`Webserver started on port ${env().TRADER_PORT}.`)
    )
}

function Authenticate(req: any, res: any): boolean {
    if (env().WEB_PASSWORD) {
        if (Object.keys(req.query).includes(env().WEB_PASSWORD)) return true

        if (Object.values(req.query).includes(env().WEB_PASSWORD)) return true
        
        logger.error("Unauthorised access request on webserver: " + req.url)

        res.send("Unauthorised.")
        return false
    }

    return true
}

function HTMLFormat(page: Pages, data: any, nextPage?: number): string {
    let html = `<html><head><title>NBT: ${page}</title></head><body>`

    // Menu
    html += `<p>`
    html += Object.values(Pages).map(name => {
        let link = ""
        if (page != name) link += `<a href="${urls[name].replace("%d", "1")}${env().WEB_PASSWORD}">`
        link += name
        if (page != name) link += `</a>`
        return link
    }).join(" | ")
    html += `<br><font size=-2>${new Date().toLocaleString()}</font>`
    html += `</p>`

    // Content
    if (data) {
        html += `<pre><code>${typeof data == "string" ? data : JSON.stringify(data, null, 4)}</code></pre>`

        // Pagination
        if (nextPage) {
            html += `<a href="${urls[page].replace("%d", nextPage.toString())}${env().WEB_PASSWORD}">Next Page...</a>`
        }
    } else {
        html += "No data yet."
    }
    
    return html + `</body></html>`
}

function HTMLTableFormat(page: Pages, data: any[], nextPage?: number): string {
    let result = ""
    if (data.length) {
        const cols = new Set<string>()
        // Because objects may have been reloaded from the database via JSON, they lose their original properties
        // So we need to check the entire dataset to make sure we have all possible columns
        for (let row of data) {
            Object.keys(row).forEach(col => cols.add(col))
        }
        
        // Add table headers before first row
        result = "<table border=1 cellspacing=0><tr>"
        for (let col of cols) {
            result += "<th>" + col + "</th>"
        }
        result += "</tr>"

        // Add row data
        for (let row of data) {
            result += "<tr>"
            for (let col of cols) {
                result += "<td"
                if (row[col] instanceof Date) {
                    // Include raw time as the tooltip
                    result += " title='" + row[col].getTime() + "'>"
                    result += row[col].toLocaleString()
                } else if (row[col] instanceof BigNumber) {
                    // Colour negative numbers as red
                    if (row[col].isLessThan(0)) result += " style='color: red;'"
                    result += ">"
                    if (row[col] != undefined) result += row[col].toFixed()
                } else {
                    // Colour true boolean values as blue
                    if (typeof(row[col]) == "boolean" && row[col]) result += " style='color: blue;'"

                    result += ">"
                    if (row[col] != undefined) result += row[col]
                }
                result += "</td>"
            }
            result += "</tr>"
        }
        if (result != "") {
            result += "</table>"
        }
    }
    return HTMLFormat(page, result, nextPage)
}

function PercentageChange(history: BalanceHistory[]): string {
    if (history.length) {
        const open = history[0].openBalance
        const close = history[history.length-1].closeBalance
        const time = Date.now() - history[0].timestamp.getTime()
        const value = close.minus(open)
        const percent = (!open.isZero()) ? value.dividedBy(open).multipliedBy(100).toFixed(2) : ""
        const apr = (!open.isZero() && time) ? value.dividedBy(open).dividedBy(time).multipliedBy(365 * 24 * 60 * 60 * 1000).multipliedBy(100).toFixed(2) : ""

        return `Value = ${value.toFixed()} | Total = ${percent}% | APR = ${apr}%`
    }
    return "No data."
}