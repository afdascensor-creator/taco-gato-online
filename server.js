services:
  - type: web
    name: taco-gato-online
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
