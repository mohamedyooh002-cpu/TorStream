module.exports = {
  apps: [{
    name: 'torrentstream',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    },
    env_development: {
      NODE_ENV: 'development'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    kill_timeout: 30000,
    listen_timeout: 10000
  }]
};
