I want to scrape this website to get the prices of all the products. I was planning to do it by category. Please, navigate to it and look at how the frontend pulls the product data from the backend, so i can figure out the logic to scrape the site with the private API (if possible).

After that, generate the logic for scraping the products in a TS script at a file called farmatodo.ts. Add some throttling so the script doesnt make more than 5 requests per minute. Also, if there's some parameter on the API that limits the number of items returned please use it with reasonable values, i dont want to abuse the API of the website. And, make a .md file with your findings, at FARMATODO.md

I use pnpm/pnpx, no npm