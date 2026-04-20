FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY docker/nginx/start-nginx.sh /start-nginx.sh
RUN chmod +x /start-nginx.sh

CMD ["/start-nginx.sh"]
