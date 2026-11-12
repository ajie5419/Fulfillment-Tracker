import { createServer } from 'node:net'

/** Isolated fixture only. Discard message contents and report delivery counts, never forward mail. */
let received = 0
createServer(socket => {
  socket.setEncoding('utf8')
  socket.write('220 fixture ESMTP\r\n')
  let buffer = '', data = false
  socket.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      if (data) {
        if (line === '.') { data = false; received++; console.log(JSON.stringify({ received })); socket.write('250 accepted\r\n') }
      } else if (/^EHLO|^HELO/.test(line)) socket.write('250 fixture\r\n')
      else if (/^MAIL|^RCPT|^RSET/.test(line)) socket.write('250 OK\r\n')
      else if (/^DATA/.test(line)) { data = true; socket.write('354 End with dot\r\n') }
      else if (/^QUIT/.test(line)) { socket.end('221 Bye\r\n') }
      else socket.write('250 OK\r\n')
    }
  })
  socket.on('error', () => socket.destroy())
}).listen(2525, '0.0.0.0')
