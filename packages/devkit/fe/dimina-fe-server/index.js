import axios from 'axios'
import cors from 'cors'
import express from 'express'
import { app } from '../server.js'

// 使用cors中间件来允许所有跨域请求
// 注意：在实际生产环境中，你应该更具体地配置CORS策略
app.use(cors())
app.use(express.json())

app.post('/proxy', async (req, res) => {
	try {
		// Input validation
		const { url, data, header = {}, timeout = 30000, method = 'GET', responseType = 'json' } = req.body

		if (!url) {
			return res.status(400).json({ error: 'URL is required' })
		}
		if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
			return res.status(400).json({ error: 'Invalid HTTP method' })
		}

		// Build request config
		const axiosConfig = {
			method: method.toUpperCase(),
			url,
			timeout: Number.parseInt(timeout, 10) || 30000,
			headers: {
				'Content-Type': 'application/json',
				...header,
			},
			// Only include data for non-GET requests
			...(method.toUpperCase() !== 'GET' && { data }),
			// For GET requests, move data to params
			...(method.toUpperCase() === 'GET' && data && { params: data }),
			responseType,
			validateStatus: () => true, // Ensure we get the response even for error status codes
		}

		// Send request to target service
		const response = await axios(axiosConfig)

		// Set appropriate content type based on response type
		if (responseType === 'arraybuffer') {
			// For arraybuffer responses, set appropriate content type from response headers or default to application/octet-stream
			const contentType = response.headers['content-type'] || 'application/octet-stream'
			res.set('Content-Type', contentType)
			res.status(response.status).send(response.data)
		}
		else {
			// For JSON responses, ensure we have proper content type
			res.set('Content-Type', 'application/json')
			res.status(response.status).json(response.data)
		}
	}
	catch (error) {
		console.error('Error forwarding request:', error.message)
		const statusCode = error.response?.status || 500
		const errorMessage = error.response?.data?.message || error.message || 'Internal Server Error'

		res.status(statusCode).json({
			error: errorMessage,
			status: statusCode,
			timestamp: new Date().toISOString(),
		})
	}
})

