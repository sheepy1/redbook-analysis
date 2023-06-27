import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { KnownDevices } from 'puppeteer'

import inquirer from 'inquirer'
import { createObjectCsvWriter as createCsvWriter } from 'csv-writer'
import fs from 'fs'
import { url } from 'inspector'

puppeteer.use(StealthPlugin())

const LOGIN_MASK = 'div.close-button'
const POST = 'a.cover.ld'
const MAX_COUNT = 5

// 定义交互式问题
const questions = [
  {
    type: 'input',
    name: 'targetURL',
    message: '请输入你想爬取的小红书页面的 URL',
    validate: function (value) {
      const isRedbook = value.includes('https://www.xiaohongshu.com/')
      return isRedbook || '请输入正确的小红书 URL'
    },
    default: 'https://www.xiaohongshu.com/explore?channel_id=homefeed.household_product_v3',
  },
  {
    type: 'input',
    name: 'count',
    message: '您需要爬取多少条数据?',
    validate: function (value) {
      var valid = !isNaN(parseFloat(value))
      return valid || '请输入一个数字'
    },
    filter: Number,
    default: 10
  },
  {
    type: 'list',
    name: 'sortBy',
    message: '将数据按什么维度倒序排序?',
    choices: ['0-默认', '1-点赞', '2-收藏', '3-评论', '4-发布日期'],
  },
  {
    type: 'input',
    name: 'headless',
    message: '是否需要查看爬虫的模拟过程? (Y/N)',
    default: 'Y'
  },
  {
    type: 'input',
    name: 'output',
    message: '请输入输出文件名',
    default: 'output.csv'
  }
]

const closeDialog = async (page) => {
  let count = 0;
  const tryToCloseDialog = async (count) => {
    if (count > MAX_COUNT) return
    await page.waitForSelector(LOGIN_MASK)
    console.log('try to close login dialog')
    await page.click(LOGIN_MASK)
  }

  try {
    await tryToCloseDialog(count)
  } catch (err) {
    count++
    console.log('failed, retry...', count)
    await tryToCloseDialog(count)
  }
}

const initContext = async (url, headless) => {
  // 启动 puppeteer
  const browser = await puppeteer.launch({
    headless,
    args: ['--disable-web-security'],
  })

  const page = await browser.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0 Win64 x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.82 Safari/537.36'
  )
  // 打开网页
  console.log(`open：${url}`)
  await page.goto(url)
  await page.waitForTimeout(3000)
  if (url.includes('explore')) {
    await closeDialog(page)
  } else {
    await page.reload()
  }

  return { browser, page }
}

const getCoverImage = async (page) => {
  // 获取 post 元素的背景图 url
  return await page.$eval(POST, node => {
    const { style } = node
    // 使用正则表达式从 style 属性中提取背景图 url
    const regex = /url\("(.+?)"\)/
    const match = style?.background?.match(regex)

    return match?.length > 1 ? match[1] : ''
  })
}

const craw = async (listPage, maxCount, browser, url) => {
  // 存储结果数据
  const results = []
  // 记录已爬取的帖子数
  let scrapedCount = 0
  // 页数
  let scrapedPage = 0
  while (scrapedCount < maxCount) {

    await listPage.waitForSelector(POST)
    // 获取页面帖子
    const posts = await listPage.$$(POST)

    for (let post of posts) {
      if (scrapedCount >= maxCount) break
      const isConnected = await listPage.evaluate(el => el.isConnected, post);
      if (!isConnected) continue

      console.log('========== analyse post: ', scrapedCount)

      // 从详情页返回的时候确保元素加载完毕
      // await page.waitForSelector(POST)

      const cover = await getCoverImage(listPage)

      // 点击帖子进入详情
      const detailPage = await browser.newPage()
      const href = await listPage.evaluate(el => el.href, post);
      await detailPage.goto(href)

      await detailPage.waitForTimeout(1000)
      await detailPage.waitForSelector('a.name')
      await detailPage.waitForSelector('div.title')
      await detailPage.waitForSelector('div.date')
      await detailPage.waitForSelector('span.count')

      const author = await detailPage.$eval('a.name', node => node.innerText)
      const title = await detailPage.$eval('div.title', node => node.innerText)
      const date = await detailPage.$eval('div.date', node => node.innerText)
      await detailPage.emulate(KnownDevices['iPhone X']);
      await detailPage.waitForTimeout(1000)
      await detailPage.reload()
      await detailPage.waitForTimeout(1000)
      await detailPage.waitForSelector('div.action-buttons')
      const getSelector = (i) => `div.action-buttons > div:nth-child(${i}) > strong > span`
      const likes = await detailPage.$eval(getSelector(1), node => node.innerText)
      const collects = await detailPage.$eval(getSelector(2), node => node.innerText)
      const comments = await detailPage.$eval(getSelector(3), node => node.innerText)

      const result = {
        author,
        cover,
        title,
        date,
        likes,
        collects,
        comments
      }
      console.log('result: ', result)
      results.push(result)

      await detailPage.close()
      scrapedCount++
    }

    if (url.includes('profile') && scrapedCount >= 10) break

    scrapedPage++
    console.log('scroll to next page: ', scrapedPage)
    // 滚动页面
    await listPage.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    await listPage.waitForTimeout(1000)
  }

  return results
}

const sort = (list, sortBy) => {
  const i = Number(sortBy.split('-')[0])
  if (!sortBy) return list
  const keys = ['likes', 'likes', 'collects', 'comments']
  const results = list.sort((a, b) => b[keys[sortBy]] - a[keys[sortBy]])
  return results
}

const output = (path, results) => {
  const csvWriter = createCsvWriter({
    path,
    header: [
      { id: 'author', title: '作者' },
      { id: 'title', title: '标题' },
      { id: 'cover', title: '封面' },
      { id: 'date', title: '发布日期' },
      { id: 'likes', title: '点赞' },
      { id: 'collects', title: '收藏' },
      { id: 'comments', title: '评论' },
    ],
    encoding: 'utf8',
    append: false
  })

  fs.writeFileSync(path, '\ufeff', { encoding: 'utf8' })  // 添加 BOM

  csvWriter.writeRecords(results).then(() => {
    console.log('爬取完成，结果已写入 out.csv 文件。')
  })
}

// 开始交互
inquirer.prompt(questions).then(async (answers) => {
  if (answers.targetURL.includes('profile') && answers.count > 10) {
    console.log('小红书个人主页最多只展示 10 个帖子，只能爬取 10 条数据……发现页没有限制')
  }
  const { browser, page } = await initContext(answers.targetURL, answers.headless === 'N' ? 'new' : false)

  const list = await craw(page, answers.count, browser, answers.targetURL)

  await browser.close()

  const results = sort(list, answers.sortBy)

  output(answers.output, results)
})

