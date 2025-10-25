# HNG-Backend-Stage-2
A RESTful API that fetches country data from an external API, stores it in a database, and provides CRUD operations.

---

### 🚀 Features

✅ Create a new country record
✅ Retrieve all countries or a specific country
✅ Update and delete country data
✅ Display system status (total countries, last refreshed timestamp)
✅ Generate a summary image of countries
✅ Consistent JSON responses and error handling

---

### 🛠️ Installation & Setup

#### 1. Clone the repository

```bash
git clone https://github.com/your-username/country-api.git
cd country-api
```

#### 2. Install dependencies

```bash
npm install
```

#### 3. Create an `.env` file

In the project root directory, add the following environment variables:

```bash
PORT=4000
DATABASE_URL=your_database_connection_string
```

#### 4. Run database migrations

If using SQL:

```bash
psql -U your_user -d your_db -f migrations/create_countries_table.sql
```

If using MongoDB:

```bash
node src/config/db/connectDb.js
```

#### 5. Start the server

```bash
npm run dev
```

The server will start at:

```
http://localhost:4000
```

---

### 📡 API Endpoints

| Method     | Endpoint           | Description                                 |
| ---------- | ------------------ | ------------------------------------------- |
| **GET**    | `/countries`       | Retrieve all countries                      |
| **GET**    | `/countries/:name` | Retrieve a specific country by name         |
| **POST**   | `/countries`       | Add a new country                           |
| **DELETE** | `/countries/:name` | Delete a specific country                   |
| **GET**    | `/status`          | Get total number of countries and timestamp |
| **GET**    | `/countries/image` | Generate and return a summary PNG image     |

---

### 📋 Example JSON Response

**GET /countries/:name**

```json
{
  "id": 1,
  "name": "Nigeria",
  "capital": "Abuja",
  "region": "Africa",
  "population": 206139589,
  "currency_code": "NGN",
  "exchange_rate": 1600,
  "estimated_gdp": 257674486.25,
  "flag_url": "https://flagcdn.com/w320/ng.png",
  "last_refreshed_at": "2025-10-25T09:00:00.000Z"
}
```

---

### ⚙️ Project Structure

```
country-api/
├── src/
│   ├── config/
│   │   └── db/
│   │       └── connectDb.js
│   ├── controllers/
│   ├── routes/
│   ├── services/
│   ├── repositories/
│   └── utils/
├── migrations/
│   └── create_countries_table.sql
├── cache/
│   └── summary.png
├── .env
├── package.json
└── server.js
```

---

### 🧪 Testing

You can test the endpoints using **Thunder Client**, **Postman**, or **cURL**.

Example:

```bash
curl http://localhost:4000/countries
```

---

### 🧑‍💻 Scripts

| Command       | Description                         |
| ------------- | ----------------------------------- |
| `npm run dev` | Run development server with Nodemon |
| `npm start`   | Run production server               |
| `npm test`    | Run automated tests (if available)  |

---

### 🪪 License

This project is licensed under the [MIT License](LICENSE).