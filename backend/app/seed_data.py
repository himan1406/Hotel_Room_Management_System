"""
Run manually: python -m app.seed_data
Seeds sample properties, rooms, documents, reviews for RAG testing.
Requires locations and admin to already be seeded (they auto-seed on boot).
"""
import hashlib
import hmac
from datetime import date, timedelta

import bcrypt

from app.database import SessionLocal
from app.models import (
    User, UserRole, Property, Room, Location, LocationType,
    PropertyDocument, DocType, Review, Booking, BookingStatus,
)
from app.config import PEPPER


# ── City knowledge profiles (used to generate rich document text) ──

CITY_PROFILES = [
    {
        "name": "Jaipur", "state": "Rajasthan", "district": "C Scheme",
        "desc": "Pink City founded in 1727 by Maharaja Sawai Jai Singh II. Known for pink-hued architecture, magnificent forts, vibrant bazaars.",
        "cuisine": "Laal Maas (fiery red mutton curry with Mathania chilies), Dal Baati Churma (baked wheat balls in ghee with lentil curry), Gatte ki Sabzi, Mawa Kachori, Ghevar honeycomb sweet. Street food: Pyaaz Kachori, Mirchi Vada at Johari Bazaar.",
        "attractions": "Hawa Mahal (953 windows, 1799). Amber Fort (hilltop, Sheesh Mahal, elephant rides). City Palace (royal residence, museum). Jantar Mantar (UNESCO observatory). Jal Mahal (floating palace).",
        "weather": "Oct-Feb best (10-28C). Summer up to 46C. Monsoon Jul-Sep. Jaipur Literature Festival in Jan.",
        "shopping": "Gemstones, Kundan/Meenakari jewelry, blue pottery, block-printed textiles, hand-knotted carpets. Johari Bazaar, Bapu Bazaar, Tripolia Bazaar.",
        "transport": "Jaipur International Airport (JAI) 13 km. Railway station 3 km. Bus stand 5 km. Auto-rickshaws, Ola/Uber available. Best explored by cycle rickshaw in old city.",
        "nearby": "Ajmer (130 km, Sharif Dargah). Pushkar (145 km, sacred lake, camel fair). Ranthambore (180 km, tiger reserve). Bhangarh Fort (85 km).",
    },
    {
        "name": "Udaipur", "state": "Rajasthan", "district": "Hiran Magri",
        "desc": "City of Lakes founded 1559 by Maharana Udai Singh II. Romantic lakes, ornate palaces, intricate havelis surrounded by Aravalli Hills.",
        "cuisine": "Dal Baati Churma (Mewari style), Ker Sangri (desert bean curry), Papad ki Sabzi, Mewa Kachori. Fine dining: Ambrai Restaurant (lake view, Rs. 2000 for two). Natraj Dining Hall (thali Rs. 400).",
        "attractions": "Lake Pichola (boat rides Rs. 400, sunset views). City Palace (largest in Rajasthan, 400 yrs, Rs. 300). Jag Mandir (island palace). Sahelion-ki-Bari. Sajjangarh Fort (Monsoon Palace, sunset panorama, Rs. 250).",
        "weather": "Oct-Mar best (12-30C). Summer up to 42C. Monsoon Jul-Sep. Shilpgram Fair Dec-Jan. Mewar Festival Mar-Apr.",
        "shopping": "Miniature paintings (Pichwai, Phad), silver jewelry, leather goods, puppets. Hathi Pol, Bada Bazaar. Shilpgram for tribal handicrafts.",
        "transport": "Maharana Pratap Airport (UDR) 22 km. Udaipur City Railway Station 3 km. Bus stand 4 km. Boat taxis on Lake Pichola. Auto-rickshaws and taxis widely available.",
        "nearby": "Kumbhalgarh Fort (85 km, 2nd longest wall after Great Wall). Ranakpur Jain Temple (100 km, 1444 marble pillars). Chittorgarh Fort (115 km, largest fort in India). Mount Abu (165 km, only Rajasthan hill station).",
    },
    {
        "name": "Jodhpur", "state": "Rajasthan", "district": "Sardarpura",
        "desc": "Blue City founded 1459 by Rao Jodha. Imposing Mehrangarh Fort dominates the skyline. Blue houses in Brahmpuri keep cool in summer.",
        "cuisine": "Makhaniya Lassi (saffron-cardamom yogurt drink, Mishri Lal Lassi Shop since 1927). Mirchi Bada. Pyaaz Kachori. Mawa Kachori. Laal Maas. Bhati Indian Restaurant, Niros for thali.",
        "attractions": "Mehrangarh Fort (122m above city, zip-lining Rs. 1500). Jaswant Thada (marble cenotaph, warm glow). Umaid Bhawan Palace (museum Rs. 50). Mandore Gardens (ancient capital). Clock Tower/Sardar Market.",
        "weather": "Arid. Summer up to 48C. Winter pleasant 25C day/10C night. Oct-Mar best. Desert Kite Festival Jan. Marwar Festival Oct-Nov.",
        "shopping": "Miniature furniture, bandhani textiles, mojari shoes, silver jewelry, carpets. Nai Sadak, Sojati Gate, Mochi Bazaar, Clock Market for spices.",
        "transport": "Jodhpur Airport (JDH) 5 km. Bhagat Ki Kothi Railway Station 3 km. Main Bus Stand 4 km. Auto-rickshaws and Ola available. Cycle rickshaws for old city.",
        "nearby": "Bishnoi Village Safari (25 km, eco-community). Kaylana Lake (10 km). Osian (65 km, ancient Jain/Hindu temples). Thar Desert camel safaris. Manvar Desert Camp.",
    },
    {
        "name": "Jaisalmer", "state": "Rajasthan", "district": "Jaisalmer",
        "desc": "Golden City founded 1156 by Rawal Jaisal. Built of golden-yellow sandstone at the heart of Thar Desert. Strategic camel trade route location.",
        "cuisine": "Dal Baati Churma, Ker Sangri (desert berry-bean curry), Panchkuta (5 desert bean curry), Mutton Saag, Gatte ki Sabzi. Rooftop dining at Trio, Killa Bhawan, Sunset Lounge.",
        "attractions": "Jaisalmer Fort (living fort, 4000 residents, UNESCO). Patwon ki Haveli (5 havelis, mirror work, Rs. 50). Sam Sand Dunes (camel safaris Rs. 500/hr, desert camps from Rs. 3000). Gadisar Lake. Bada Bagh (royal cenotaphs).",
        "weather": "Extreme desert. Summer up to 48C. Winter 24C day/5C night. Nov-Feb best. Desert Festival Feb (camel races, Mr. Desert contest, folk music). Annual rainfall under 200mm.",
        "shopping": "Mirror-work textiles, leather jootis, silver jewelry, stone carvings, woolen carpets. Fort market, Manak Chowk, Sadar Bazaar, Bhatia Market.",
        "transport": "Jaisalmer Airport (domestic, limited flights). Railway station 3 km (Palace on Wheels, tourist trains). Bus stand 2 km. Camel safaris for desert exploration.",
        "nearby": "Kuldhara village (20 km, abandoned 1825, haunted). Khaba Fort. Desert National Park (45 km, Great Indian Bustard). Long-distance camel safaris into deep Thar.",
    },
    {
        "name": "Delhi", "state": "Delhi", "district": "New Delhi",
        "desc": "India's capital since 6th century BCE. Seven cities built over millennia. From Mughal Shah Jahanabad to Lutyens' Delhi.",
        "cuisine": "Butter Chicken at Moti Mahal (inventor). Paranthe wali Gali (since 1870s). Daulat ki Chaawat (winter only). Karim's near Jama Masjid (since 1913, Mughlai). Chaat at Natraj. Wenger's (since 1926) for chicken patties.",
        "attractions": "Red Fort (UNESCO, 1639, Rs. 35). Qutub Minar (73m, 1193, Rs. 35). India Gate (war memorial). Humayun's Tomb (UNESCO, 1572). Lotus Temple (Bahai, free).",
        "weather": "Extreme continental. Summer up to 45C. Monsoon Jul-Sep. Winter 20C day/3C night, foggy. Oct-Mar best.",
        "shopping": "Dilli Haat (crafts from all states). Chandni Chowk (spices, fabrics, electronics). Sarojini Nagar (budget fashion). Khan Market (luxury, books). Janpath (boho). Daryaganj Sunday book market.",
        "transport": "Indira Gandhi International Airport (DEL) 16 km. Major railway stations: New Delhi, Old Delhi, Hazrat Nizamuddin. Metro network connects entire city. Buses, autos, Ola/Uber. Hop-on-hop-off buses for tourists.",
        "nearby": "Agra (230 km, Taj Mahal). Jaipur (280 km). Mathura (145 km, Krishna birthplace). Vrindavan (150 km). Neemrana Fort (120 km). Sohna hot springs (80 km).",
    },
    {
        "name": "Agra", "state": "Uttar Pradesh", "district": "Agra",
        "desc": "City of Taj Mahal, capital of Mughal Empire under Akbar, Jahangir, Shah Jahan. Three UNESCO World Heritage sites.",
        "cuisine": "Bedai (fried lentil bread, Deviram Sweets since 1935). Dalmoth (spicy lentil-nut mix). Petha (winter melon sweet, dozens of varieties). Murg Musallam, Galouti Kebab. Peshawri at ITC Mughal. Bhalla, kachori at Sadar Bazaar.",
        "attractions": "Taj Mahal (Wonder of World, 1632-53, Rs. 50 Indians/Rs. 1100 foreigners, closed Fri). Agra Fort (UNESCO, 1565-73, Rs. 35). Fatehpur Sikri (40 km, UNESCO, 1571-85, Buland Darwaza 54m, Rs. 50).",
        "weather": "Summer up to 47C. Monsoon moderate. Winter 22C day/4C night with fog. Oct-Mar best. Taj Mahotsav Feb (10-day cultural fest).",
        "shopping": "Marble inlay work (Pietra Dura), leather goods, carpets (Agra carpets world-renowned), zari/zardozi embroidery. Sadar Bazaar, Kinari Bazaar, Taj Ganj. UP Handicrafts Emporium.",
        "transport": "Agra Airport (AGR) 7 km. Agra Cantt Railway Station 5 km (Gatimaan Express 100min from Delhi). Bus stand 3 km. Cycle rickshaws, auto-rickshaws, taxis. Battery buses to Taj Mahal from parking.",
        "nearby": "Mathura (55 km, Krishna Janmabhoomi). Vrindavan (65 km, Banke Bihari Temple). Bharatpur/Keoladeo National Park (55 km, UNESCO bird sanctuary, 370 species). Chambal Safari (80 km, gharials, dolphins).",
    },
    {
        "name": "Rishikesh", "state": "Uttarakhand", "district": "Rishikesh",
        "desc": "Yoga Capital of World at Himalayan foothills where Ganga emerges from mountains. Beatles visited 1968. Gateway to Char Dham pilgrimage.",
        "cuisine": "Vegetarian/sattvic due to religious significance. Aloo Puri, Chole Bhature (Chotiwala). Beatles Cafe for Israeli/Mediterranean. German Bakery for pizza. Tapovan dhabas for Kumaoni cuisine. Ghat-side chai stalls.",
        "attractions": "Laxman Jhula/Ram Jhula (iconic suspension bridges). Triveni Ghat Evening Aarti (sunset, free). Beatles Ashram (Chaurasi Kutia, Rs. 150). Rajaji National Park (tiger/elephant reserve, safaris Rs. 3500). Shivpuri rafting (Grade 3-4 rapids).",
        "weather": "Summer 25-40C. Monsoon heavy (rafting suspended). Winter 20C day/4-8C night. Oct-Apr best for rafting. International Yoga Festival in March.",
        "shopping": "Incense, meditation cushions, rudraksha beads, singing bowls, prayer flags, hemp clothing, Ayurvedic medicines. Laxman Jhula market, Tibetan Market.",
        "transport": "Jolly Grant Airport (Dehradun) 35 km. Rishikesh Railway Station 3 km. Bus stand 2 km. Taxis, auto-rickshaws. Shared jeeps to nearby destinations.",
        "nearby": "Neelkanth Mahadev Temple (32 km). Vashishtha Gufa (24 km, meditation cave). Kunjapuri Temple (28 km, sunrise Himalayan view). Haridwar (25 km, Har Ki Pauri Ganga Aarti). Char Dham: Badrinath, Kedarnath, Gangotri, Yamunotri.",
    },
    {
        "name": "North Goa", "state": "Goa", "district": "North Goa",
        "desc": "Portuguese colony for 451 years until 1961. Pearl of Orient. Stunning beaches, vibrant nightlife, unique Indo-Portuguese culture.",
        "cuisine": "Goan Fish Curry (coconut-based). Prawn Balchao (pickled in fiery masala). Pork Vindaloo (Portuguese origin). Xacuti (16-spice curry). Sorpotel (sour pork). Bebinca (layered coconut dessert). Cashew Feni (local spirit). Saturday Night Market Arpora.",
        "attractions": "Calangute Beach (Queen of Beaches, water sports). Basilica of Bom Jesus (UNESCO, 1605, St. Francis Xavier relics). Fort Aguada (17th-century Portuguese). Palolem Beach (crescent bay, silent discos). Dudhsagar Waterfalls (310m, jeep safari Rs. 2500). Anjuna Flea Market (Wednesdays).",
        "weather": "Dry season Nov-May best (25-33C). Monsoon Jun-Oct heavy, lush, fewer tourists. Carnival Feb (pre-Lenten). Dec-Jan peak season. Monsoon ideal for Ayurveda.",
        "shopping": "Anjuna Flea Market (hippie legacy, Wed). Mapusa Friday Market (local). Saturday Night Market Arpora. Cashew nuts, Goan sausages, port wine, Feni. Fontainhas antiques (Panjim Latin Quarter).",
        "transport": "Goa International Airport (GOI) 25 km (Dabolim), new Mopa airport also. Thivim Railway Station 20 km. Madgaon Railway Station 40 km. Taxis, auto-rickshaws. Scooter/bike rentals popular. Ferry services across Mandovi River.",
        "nearby": "South Goa (Palolem, Agonda, Patnem, Butterfly Beach). Bhagwan Mahavir Wildlife Sanctuary. Ponda spice plantations (Sahakari, Tropical). Old Goa cathedrals (Se Cathedral). Chorao Island bird sanctuary (Salim Ali).",
    },
    {
        "name": "Mumbai", "state": "Maharashtra", "district": "South Mumbai",
        "desc": "India's financial, commercial, entertainment capital. Seven islands merged over 300 years. Bollywood, Gateway of India, Dharavi.",
        "cuisine": "Pav Bhaji (Cannon's, Sardar Refreshments). Vada Pav (Ashok Vada Pav Dadar). Bhel Puri (Chowpatty). Butter Garlic Crab at Trishna. Britannia Berry Pulav (since 1923). Kyani & Co (since 1904) bun maska. Mohammed Ali Road street food (Ramadan).",
        "attractions": "Gateway of India (26m arch, 1924). Marine Drive (Queen's Necklace). Elephanta Caves (UNESCO, ferries from Gateway, 9AM-2PM). CSMT (UNESCO railway station). Siddhivinayak Temple (100K devotees daily). Dharavi slum tours.",
        "weather": "Monsoon Jun-Sep heavy (2200mm). Oct-Feb best (20-32C). Summer Mar-May hot/humid up to 38C. Never truly cold.",
        "shopping": "Colaba Causeway (street market). Linking Road Bandra (fashion). Chor Bazaar (antiques, flea). Zaveri Bazaar (gold/diamond). Palladium Mall (luxury). Fashion Street (budget). Crawford Market (spices).",
        "transport": "Chhatrapati Shivaji Maharaj International Airport (BOM) 18 km. CSMT/Dadar/Kurla railway stations. BEST buses, autos, taxis, Ola/Uber. Local trains (lifeline, 7M+ daily). Monorail, Metro under expansion. Ferries to Elephanta/Alibaug.",
        "nearby": "Lonavala/Khandala (85 km, hill stations, chikki). Alibaug (100 km, ferry, beaches). Sanjay Gandhi NP (40 km, Kanheri Caves, leopards). Matheran (110 km, auto-free, toy train UNESCO). Nashik (170 km, wine capital, Sula Vineyards).",
    },
    {
        "name": "Pune", "state": "Maharashtra", "district": "Koregaon Park",
        "desc": "Cultural capital of Maharashtra. Seat of Maratha Empire under Peshwas. Major education/IT hub. Osho International Meditation Resort.",
        "cuisine": "Misal Pav (Shri Krishna Misal, Katakirr, Bedekar since 1945). Sabudana Khichdi/Vada. Mastani (thick milkshake with ice cream). Goodluck Cafe (since 1935). Vaishali (since 1971, South Indian). Kayani Bakery (since 1955, Shrewsbury biscuits). Malaka Spice (Pan-Asian).",
        "attractions": "Aga Khan Palace (1892, Gandhi prison, Rs. 50). Shaniwar Wada (1732, Peshwa palace, sound/light show 7:15PM, Rs. 25). Osho Meditation Resort (40 acres, visitor pass Rs. 2000). Sinhagad Fort (30 km, 1300m, Tanaji Malusare legend). Raja Dinkar Kelkar Museum (20000 artifacts, Rs. 50).",
        "weather": "Pleasant compared to Mumbai (elevation 560m). Summer 25-40C. Monsoon moderate (750mm). Oct-Feb best (20-32C day). Dec-Jan can drop to 8C morning.",
        "shopping": "Tulshi Baug (traditional Maharashtrian jewelry). FC Road (college hub, books, street food). MG Road (brands, Sunday book market). Kasba Peth (Paithani sarees, Kolhapuri chappals). Phoenix Marketcity (large mall). Koregaon Park (boutiques).",
        "transport": "Pune International Airport (PNQ) 12 km. Pune Railway Station 3 km (Deccan Queen, Shatabdi). Bus stand 5 km. Auto-rickshaws, Ola/Uber. PMPML buses. Metro under construction.",
        "nearby": "Lonavala/Khandala (65 km). Karla/Bhaja Caves (65 km, 2nd century BCE Buddhist). Mahabaleshwar (120 km, strawberry capital, Pratapgad Fort). Kaas Plateau (140 km, UNESCO wildflower biodiversity, Aug-Sep).",
    },
    {
        "name": "Bangalore", "state": "Karnataka", "district": "Indiranagar",
        "desc": "India's Silicon Valley, founded 1537 by Kempe Gowda. Garden City, Pub Capital, Startup Capital. Pleasant year-round climate.",
        "cuisine": "Masala Dosa at Vidyarthi Bhavan (since 1943). Rava Idli at MTR (since 1924). Benne Masala Dosa at SLV (butter dosa). Koshy's (since 1940, fish and chips). Toit (craft brewery pioneer). Halli Thindi (Kannadiga meal on banana leaf). Filter coffee at Brahmin's Coffee Bar.",
        "attractions": "Lalbagh Botanical Garden (240 acres, 1760, glasshouse, flower shows, Rs. 25). Bangalore Palace (Tudor-style, 1887, Rs. 230). Cubbon Park (300 acres, 6000 trees, High Court, library). ISKCON Temple (largest Krishna temple). Nandi Hills (60 km, 1478m, Tipu's Summer Retreat, sunrise, Rs. 30).",
        "weather": "Perpetual spring (elevation 920m). 15-33C year-round. Moderate rainfall (860mm). Oct-Feb best (25C day, cool evenings). Jan can drop to 14C morning.",
        "shopping": "Commercial Street (all-in-one). Chickpet Market (fabric wholesale, Asia's largest). Gandhi Bazaar (flowers, produce). Brigade Road/MG Road (brands). UB City (luxury). Cauvery Emporium (Govt handicrafts, fixed prices). Malleswaram Market (local shopping).",
        "transport": "Kempegowda International Airport (BLR) 40 km. Yeshwanthpur/Majestic/KSR Railway Stations. Namma Metro (growing network). BMTC buses. Ola/Uber. Auto-rickshaws. Bicycle-sharing in some areas.",
        "nearby": "Mysore (145 km, Mysore Palace, Brindavan Gardens, Dasara). Srirangapatna (130 km, Tipu's capital). Coorg/Madikeri (260 km, coffee plantations, waterfalls, Tibetan settlement Bylakuppe). Belur/Halebidu (220/230 km, Hoysala temples). Kabini River (210 km, tiger reserve, safari).",
    },
    {
        "name": "Chennai", "state": "Tamil Nadu", "district": "Teynampet",
        "desc": "Capital of Tamil Nadu, founded 1639 by British around Fort St. George. Gateway to Dravidian temple culture. Carnatic music, Bharatnatyam, Kollywood.",
        "cuisine": "Filter Coffee (kaapi, Saravana Bhavan, Murali's). Idli/Vada/Dosa (MTR, pillowy idlis). Chettinad Chicken (fiery, Dakshin, Karaikudi). Kothu Parotta (shredded flatbread). Marina Beach sundal/bhajji. Grand Sweets Mysore Pak (since 1958). Lunch thali on banana leaf.",
        "attractions": "Marina Beach (13 km, 2nd longest urban beach). Fort St. George (1644, oldest British fort, St. Mary's Church, museum Rs. 50). Kapaleeshwarar Temple (7th-century Pallava, 37m gopuram). Santhome Basilica (St. Thomas tomb). Government Museum (est. 1851, 50000 artifacts, Roman antiquities, Chola bronzes).",
        "weather": "Tropical wet/dry. Apr-Jun hottest (42C, 75%+ humidity). NE monsoon Oct-Dec (cyclonic). Nov-Feb best (20-29C, lower humidity). Jan-Feb most pleasant with sea breezes.",
        "shopping": "T. Nagar (Usman Road, Ranganathan St: gold jewelry, Kanchipuram silks). Pondy Bazaar (street shopping). Spencer Plaza (since 1863, oldest mall). Poompuhar Govt Emporium (Tanjore paintings, bronze lamps). Mylapore (antiques, Sunday market). Higginbotham's Bookstore (since 1844).",
        "transport": "Chennai International Airport (MAA) 15 km. Chennai Central/MCB Railway Stations. Chennai Metro. MTC buses. Auto-rickshaws, Ola/Uber. Suburban rail network. Port for cruise ships.",
        "nearby": "Mahabalipuram (60 km, UNESCO Pallava rock-cut, Shore Temple, Five Rathas, Arjuna's Penance Rs. 40). Kanchipuram (75 km, City of Thousand Temples, silk sarees). Tiruvannamalai (180 km, Annamalaiyar Temple, Arunachala Hill pilgrimage). Pondicherry (160 km, French Quarter, Auroville).",
    },
    {
        "name": "Hyderabad", "state": "Telangana", "district": "Jubilee Hills",
        "desc": "City of Pearls and Nizams, founded 1591 by Muhammad Quli Qutb Shah. Blend of historic old city and modern tech hub HITEC City.",
        "cuisine": "Hyderabadi Biryani (Paradise since 1953, Bawarchi, Shadab). Haleem (Ramadan specialty, UNESCO recognized, Pista House). Mirchi ka Salan. Double ka Meetha (bread pudding). Irani Chai at Nimrah Cafe (100+ years, with Osmania biscuits). Nihari (slow-cooked stew).",
        "attractions": "Golconda Fort (13th-century, acoustic system, sound/light show Rs. 140). Charminar (1591, 56m, Rs. 50). Hussain Sagar Lake (heart-shaped, 18m Buddha statue). Salar Jung Museum (43000 artifacts, Veiled Rebecca, ivory collection, Rs. 50). Ramoji Film City (largest studio complex, 1666 acres, Rs. 1150).",
        "weather": "Tropical. Summer up to 42C but low humidity. Monsoon moderate (810mm). Oct-Feb best (13-30C). Winter clear skies, perfect for exploring. Monsoon beautiful in old city.",
        "shopping": "Pearls (Pathergatti, Mangatrai, MG Road). Laad Bazaar (Charminar, bangles, lacquer, khara dupattas). Sultan Bazaar (textiles, sherwanis). Begum Bazaar (wholesale market). Lepakshi Handicrafts (Bidriware, Kalamkari, Pochampally silk Ikat).",
        "transport": "Rajiv Gandhi International Airport (HYD) 25 km. Secunderabad/Nampally/Kacheguda Railway Stations. Hyderabad Metro. TSRTC buses. Auto-rickshaws, Ola/Uber. MMTS local trains.",
        "nearby": "Warangal (150 km, Thousand Pillar Temple, Kakatiya Fort, Ramappa Temple UNESCO). Nagarjuna Sagar Dam (150 km, Buddhist site Nagarjunakonda). Undavalli Caves (40 km, 7th-century rock-cut). Medak Church (100 km, largest in Asia). Bidar (140 km, Bidar Fort, Mahmud Gawan madrasa).",
    },
    {
        "name": "Kolkata", "state": "West Bengal", "district": "Alipore",
        "desc": "Cultural and intellectual capital of India. British capital 1772-1911. Birthplace of Bengal Renaissance, Satyajit Ray, Tagore, Mother Teresa.",
        "cuisine": "Kathi Roll (Nizam's since 1932). Chinese in Tangra (Chinatown). Phuchka (Vardaan Market). Jhal Muri (puffed rice snack). Macher Jhol (fish curry). Shorshe Ilish (hilsa in mustard). Roshogolla (KC Das since 1928). Sandesh (Bhim Chandra Nag since 1865). Mishti Doi (sweet yogurt). Indian Coffee House College Street (since 1876).",
        "attractions": "Victoria Memorial (white marble, 1906-21, 64 acres gardens, Rs. 50). Howrah Bridge (1943, no nuts/bolts, riveted, 4M pedestrians daily). Dakshineswar Kali Temple (nine-spired, Ramakrishna's room). Indian Museum (est. 1814, oldest in India, 100K+ artifacts, Rs. 75). Mother House (Mother Teresa's tomb, free).",
        "weather": "Summer hot/humid up to 40C. Kalboishakhi storms Apr-May. Monsoon heavy (1600mm). Oct-Nov pleasant (28-32C, Durga Puja). Dec-Feb cool (12-25C). Best Oct-Mar. Kolkata International Film Festival Nov. Book Fair Jan-Feb.",
        "shopping": "New Market (1874, 2000+ stalls, Gothic). College Street (Asia's largest second-hand book market). Gariahat (Baluchari sarees, Jamdani muslin). Dakshinapan (dokra metal crafts, terracotta). K.C. Das/Bhim Chandra Nag (sweets). Park Street (boutiques, luxury).",
        "transport": "Netaji Subhas Chandra Bose International Airport (CCU) 18 km. Howrah/Sealdah Railway Stations. Kolkata Metro (oldest in India). Trams (heritage, only city with trams). Yellow Ambassador taxis (iconic). Auto-rickshaws. Hand-pulled rickshaws (heritage). Ferry across Hooghly.",
        "nearby": "Sundarbans (110 km, world's largest mangrove, Royal Bengal Tiger, UNESCO). Chandannagar (50 km, French colonial). Serampore (25 km, Danish colony, St. Olav's Church 1806). Bishnupur (150 km, terracotta temples). Darjeeling (630 km, tea gardens, Himalayan views, toy train UNESCO).",
    },
    {
        "name": "Kochi", "state": "Kerala", "district": "Ernakulam",
        "desc": "Queen of Arabian Sea. Natural harbor, spice trade center for millennia. First European settlement in India (1503). Blend of colonial cultures.",
        "cuisine": "Kerala Sadhya (banana leaf feast, 20+ dishes). Fish Molee (coconut milk stew, Portuguese influence). Meen Pollichathu (banana leaf wrapped fish). Kozhikode Biryani (Malabar spice blend). Malabar Parotta (layered flatbread). Malabar Halwa. Banana chips (ubiquitous). Toddy (kallu shap) with fried fish.",
        "attractions": "Backwaters of Alleppey (houseboats, Rs. 6000-25000/night). Munnar (1600m, tea plantations, Eravikulam NP, Nilgiri Tahr). Fort Kochi (Chinese fishing nets, St. Francis Church 1503, Dutch Palace, Paradesi Synagogue 1568). Kumarakom Bird Sanctuary. Mattancherry Palace murals.",
        "weather": "Tropical, two monsoons. SW monsoon Jun-Sep heaviest. NE monsoon Oct-Nov. Summer Mar-May hot/humid 35C. Dec-Feb best (22-32C). Monsoon ideal for Ayurveda treatments.",
        "shopping": "Spices (Spices Board Kochi). Kathakali masks. Coconut shell products. Kerala mural paintings. Coir products from Alleppey. Kasavu mundu (traditional gold-border wear). Aranmula metal mirrors (500-yr craft). MG Road Kochi. Connemara Market Thiruvananthapuram.",
        "transport": "Cochin International Airport (COK) 28 km. Ernakulam Junction Railway Station 5 km. Ferry services across backwaters and harbor. Auto-rickshaws, taxis. Houseboat cruises for backwater tourism.",
        "nearby": "Wayanad (260 km, Edakkal Caves 6000-yr petroglyphs, Chembra Peak). Kozhikode (200 km, Vasco da Gama landing 1498, Kappad Beach). Thekkady/Periyar (200 km, tiger reserve, boat safaris on lake). Kovalam/Thiruvananthapuram (Padmanabhaswamy Temple, world's richest).",
    },
    {
        "name": "Munnar", "state": "Kerala", "district": "Idukki",
        "desc": "Breathtaking hill station at 1600m in Western Ghats. Endless tea plantations carpeting rolling hills. British summer resort. Tea Museum by Tata Tea.",
        "cuisine": "Kerala cuisine with tea-themed variations. Fresh tea from plantations. Appam with stew, Puttu and Kadala Curry (rice cake with chickpeas). Kerala fish curry, tapioca with fish. Local spices in every dish.",
        "attractions": "Eravikulam National Park (endangered Nilgiri Tahr, Anamudi peak 2695m highest South India). Mattupetty Dam (boating, tea gardens backdrop). Tea Museum (150-yr history, antique machinery, tasting). Top Station viewpoint (panoramic Western Ghats to Tamil Nadu). Attukal/Kundala/Sholayar waterfalls.",
        "weather": "Pleasant year-round (10-25C). Summer 20-25C. Monsoon Jun-Sep heavy, misty. Dec-Feb cool (5-15C, ideal). Snow is not known but winter mornings are crisp and cold. Best time Oct-Feb.",
        "shopping": "Tea (all varieties, direct from plantations). Spices (cardamom, pepper, cinnamon, nutmeg). Homemade chocolates. Eucalyptus oil, essential oils. Munnar market for souvenirs. Handloom stores.",
        "transport": "Nearest airport: Cochin International (130 km, 4hr drive). Nearest railway: Aluva (110 km) or Ernakulam. Well-connected by road (KSRTC buses, taxis from Kochi). Local autos and taxis for sightseeing.",
        "nearby": "Alleppey backwaters (160 km). Thekkady/Periyar (110 km). Cochin (130 km). Theni and Kodaikanal (110 km, Tamil Nadu hill station). Valparai (90 km, tea plantations, scenic drive).",
    },
    {
        "name": "Coorg", "state": "Karnataka", "district": "Madikeri",
        "desc": "Scotland of India. Coffee plantations, misty hills, spice gardens, Tibetan settlements. Distinctive Kodava culture with martial traditions.",
        "cuisine": "Coorgi Pandi Curry (pork cooked with vinegar and special Coorgi spices). Kadambuttu (steamed rice dumplings). Kumm curry (mushroom). Nool puttu (rice noodles). Akki Otti (rice roti). Coffee (Arabica/Robusta from local plantations). Kaipuli (citrus juice).",
        "attractions": "Abbey Falls, Iruppu Falls, Mallalli Falls (each unique, surrounded by forests). Dubare Elephant Camp (elephant bathing, feeding, rides). Raja's Seat (sunset viewpoint, gardens). Bylakuppe Tibetan Settlement (2nd largest in India, Namdroling Monastery golden temples). Nagarhole National Park (tiger reserve, jungle safaris).",
        "weather": "Pleasant year-round (15-28C). Summer 20-28C. Monsoon Jun-Sep very heavy (misty, dramatic). Oct-Mar best. Dec-Feb cool (10-20C).",
        "shopping": "Coffee beans (fresh roasted). Spices (cardamom, pepper, vanilla, cinnamon). Coorgi honey (famous). Homemade chocolates. Bamboo crafts. Traditional Kodava jewelry and clothing.",
        "transport": "Nearest airport: Mysore (125 km) or Mangalore (135 km). Nearest railway: Mysore. Well-connected by road from Bangalore (260 km, 5hr), Mysore. KSRTC buses, taxis. Local autos for town exploration.",
        "nearby": "Mysore (125 km, palace, gardens). Kabini River (80 km, tiger reserve, luxury lodges). Talakaveri (45 km, origin of Kaveri River, temple). Bhagamandala (45 km, confluence of three rivers). Mangalore (135 km, beaches, temples).",
    },
    {
        "name": "Mysore", "state": "Karnataka", "district": "Mysore",
        "desc": "Cultural capital of Karnataka. City of Dasara, palaces, silk, sandalwood. Wodeyar dynasty seat. Illuminated Mysore Palace.",
        "cuisine": "Mysore Masala Dosa (spiced red chutney). Mysore Pak (ghee-gram flour sweet, invented at Mysore Palace). Bisi Bele Bhaath (spiced rice-lentil hotpot). Chiroti (fried dessert with milk). Filter coffee. Shanthi Sagar, Mylari (iconic dosa). Vinayaka Mylari for melt-in-mouth dosa. Original Mysore Pak at Guru Sweet Mart.",
        "attractions": "Mysore Palace (one of India's most visited, 97K lights on Sundays, Rs. 100). Brindavan Gardens (musical fountain, 6:30PM show). Chamundi Hills (Nandi Bull 4.8m, temple, panoramic view). Mysore Zoo (est. 1892, one of oldest). Railway Museum. St. Philomena's Church (neo-Gothic). Dasara procession (10-day festival, elephant parade).",
        "weather": "Pleasant. Summer 20-35C. Monsoon moderate (800mm). Oct-Feb best (15-30C). Dec-Jan cool (10-20C). Dasara in Sep-Oct best time with pleasant weather and grand festivities.",
        "shopping": "Mysore Silk sarees (Govt Silk Factory). Sandalwood oil/products (Govt Sandalwood Depot). Handicrafts: ivory inlay (rosewood). Incense sticks. Mysore Peta (traditional turban). Devaraja Market (spices, flowers, fruits). Cauvery Emporium.",
        "transport": "Mysore Airport (MYQ) 10 km (limited flights). Mysore Railway Station 2 km. Bus stand 1 km. Auto-rickshaws, taxis. City buses. Cycle rickshaws for old city.",
        "nearby": "Srirangapatna (20 km, Tipu's summer palace, Gumbaz). Coorg (125 km). Kabini (80 km). Bandipur Tiger Reserve (80 km). Belur/Halebidu (80/90 km, Hoysala temples). Wayanad (100 km). Ooty (160 km, Nilgiri toy train).",
    },
    {
        "name": "Pondicherry", "state": "Puducherry", "district": "White Town",
        "desc": "Former French colony (1674-1954). French Quarter with colonial buildings, tree-lined streets, croissants alongside filter coffee. Sri Aurobindo Ashram, Auroville.",
        "cuisine": "Unique French-Indian fusion. Seafood bouillabaisse, ratatouille alongside South Indian staples. Baker Street for croissants. Cafe des Arts, Le Club, Rendezvous for French cuisine. Gingee for rooftop dining. Sita Cafe for tapas and wine. Kasha Ki Aasha for organic. Banana boat and ice cream at Promenade Beach.",
        "attractions": "French Quarter (White Town, colonial villas, bougainvillea-lined streets). Promenade Beach (1.5km, Gandhi statue, war memorial). Sri Aurobindo Ashram (tranquil, meditation hall). Auroville (15 km, experimental township, Matrimandir golden sphere, Peace Area). Bharati Park. Pondicherry Museum. Botanical Gardens.",
        "weather": "Coastal tropical. Summer 25-38C (May-Jun hottest). NE monsoon Oct-Dec. Dec-Feb best (20-30C, pleasant breeze). Humidity fairly high year-round. Cyclones possible Oct-Dec.",
        "shopping": "Goubert Avenue (night market, handicrafts, clothes). Mission Street (textiles, souvenirs). Serenity Beach area (Auroville products). Auroville shops (handmade paper, essential oils, organic products, incense). Boutiques in White Town for French-style clothing. Kennedy & Co (since 1885) for antiques.",
        "transport": "Puducherry Airport (PNY) 5 km (limited direct flights, mostly via Chennai/Vijayawada). Villupuram Railway Junction (40 km, connects to major cities). Well-connected by road from Chennai (160 km, 3.5hr). Local: cycles, scooters (popular), autos, taxis.",
        "nearby": "Chennai (160 km). Mahabalipuram (100 km). Auroville (15 km). Chunnambar Backwaters (8 km, boat house, Paradise Beach). Gingee Fort (70 km, formidable hill fortress). Tiruvannamalai (100 km, Arunachaleswarar Temple).",
    },
    {
        "name": "Darjeeling", "state": "West Bengal", "district": "Darjeeling",
        "desc": "Queen of Hills. World-famous tea gardens producing champagne of teas. Himalayan views including Kanchenjunga. UNESCO Darjeeling Himalayan Railway.",
        "cuisine": "Momos (steamed/fried dumplings, pork/chicken/veg). Thukpa (Tibetan noodle soup). Shabhaley (deep-fried Tibetan bread with meat filling). Phagshapa (pork with radish). Darjeeling tea (first flush, second flush, autumn flush). Chicken Cheese Roll (local variant). Keventer's for breakfast (since 1910, pork sausages, toast). Glenary's Bakery (since 1918, coffee, pastries).",
        "attractions": "Tiger Hill (sunrise over Kanchenjunga, 13km, 4AM start). Darjeeling Himalayan Railway (Toy Train, UNESCO, Batasia Loop). Himalayan Mountaineering Institute (Tenzing Norgay's gear, Everest history). Peace Pagoda (Japanese Buddhist, 4 avatars of Buddha). Padmaja Naidu Himalayan Zoological Park (red panda, snow leopard). Happy Valley Tea Estate (tour, tasting). Rock Garden, Ganga Maya Park.",
        "weather": "Summers mild (15-25C). Monsoon Jun-Sep very heavy (misty, landslides possible). Oct-Nov clear skies, spectacular mountain views. Dec-Feb cold (2-10C, occasional snow). Mar-Apr pleasant, rhododendrons bloom (beautiful). Best times: Oct-Nov and Mar-May.",
        "shopping": "Tea (all varieties, buy from Tea Board shops, Happy Valley, Glenburn). Tibetan handicrafts (thangkas, prayer flags, singing bowls). Woolens (pashmina, shawls). Handmade paper products. Local handicrafts, jewelry. Chowk Bazaar (local market). Mall Road shops.",
        "transport": "Bagdogra Airport (IXB) 70 km (3hr drive). New Jalpaiguri Railway Station (NJP) 65 km. Darjeeling Himalayan Railway from NJP (Toy Train, 7hr, unforgettable). Shared jeeps from Siliguri/NJP. Local: walking (main way), taxis, shared jeeps. Steep roads, not suitable for private cars without experience.",
        "nearby": "Kalimpong (50 km, flower market, Buddhist monasteries). Gangtok (100 km, Sikkim capital, Tsomgo Lake, Nathula Pass-permit needed). Mirik (50 km, tea gardens, Sumendu Lake). Kurseong (30 km, 'Land of White Orchids', toy train passes through). Singalila Ridge Trekking (remarkable Himalayan trails, Sandakphu peak for Everest view).",
    },
    {
        "name": "Gangtok", "state": "Sikkim", "district": "Gangtok",
        "desc": "Capital of Sikkim, perched at 1650m overlooking Kanchenjunga range. Buddhist culture, monasteries, organic state, cleanest city in India.",
        "cuisine": "Sikkimese cuisine: Gundruk (fermented leafy green). Phagshapa (pork belly with radish, dried chilies). Momos (buff/pork/veg). Thukpa. Thenthuk (hand-pulled noodle soup). Ningro (nettle soup). Sel Roti (rice bread ring). Craft beer: Mount Kanchenjunga beer, Dansberg (brewed in Gangtok). Baker's Cafe, Cafe Live & Loud, The Coffee Shop for relaxation.",
        "attractions": "Tsomgo Lake (40 km, 3753m, glacial, only with permit, Nov-Jun frozen). Rumtek Monastery (24 km, largest in Sikkim, 1960s, exquisite murals, sacred relics). MG Marg (pedestrian-only main street, flowers, cafes, shops). Nathula Pass (56 km, 4310m, India-China border, permit needed, opens Wed-Sun). Tashi Viewpoint. Enchey Monastery (200 years old). Banjhakri Falls. Do Drul Chorten Stupa. Flower Exhibition Centre. Himalayan Zoological Park.",
        "weather": "Summers 15-25C (pleasant). Monsoon Jun-Sep heavy (landslide risk). Oct-Mar cold (2-15C). Dec-Feb very cold (0-10C, snow possible). Best times: Mar-Jun, Oct-Dec. Spring rhododendrons bloom spectacularly across hillsides.",
        "shopping": "Buddhist artifacts (thangkas, prayer wheels, singing bowls). Handicrafts: carpets, woodwork, handmade paper. Sikkimese tea (temis tea, orchid tea). Organic spices (cardamom, Sikkim's famous large cardamom). Traditional clothing (kho, bakhu). MG Marg for all shopping. Government Handloom & Handicrafts Emporium.",
        "transport": "Pakyong Airport (Sikkim's first airport, 34 km, limited flights, weather-dependent). Nearest major airport: Bagdogra (130 km, 5hr drive). New Jalpaiguri Railway Station (130 km). Shared jeeps from Siliguri/NJP. Local: walking (MG Marg), taxis, shared cabs. Permits required for foreigners (can be arranged through hotels/agents).",
        "nearby": "Tsomgo Lake (40 km). Nathula Pass (56 km, permit). Baba Mandir (memorial of soldier Harbhajan Singh). Rumtek Monastery (24 km). Zuluk (95 km, breathtaking hairpin bends, Old Silk Route). Yumthang Valley (150 km, Valley of Flowers Sikkim, hot springs). Yuksom (140 km, start of Kanchenjunga trek, Coronation throne of first Chogyal).",
    },
    {
        "name": "Varanasi", "state": "Uttar Pradesh", "district": "Varanasi",
        "desc": "World's oldest continuously inhabited city (3500+ years). Spiritual capital of India. Ganga ghats, Ganga Aarti, Kashi Vishwanath Temple. Buddhism's Sarnath nearby.",
        "cuisine": "Kashi Chat (tamatar chaat, aloo chaat, puri sabzi). Baati Chokha (baked wheat balls with mashed eggplant). Malaiyyo (winter special milk froth dessert). Kachori Sabzi (Deena Chat Bhandar). Thandai (saffron-milk drink with nuts, famous during Mahashivratri). Banarasi Paan (betel leaf with fillings). Lassi at Blue Lassi (since 1925, 50+ varieties). Kulfi at Keshari. Shri Ram Bhandar kachori.",
        "attractions": "Ganga Aarti at Dashashwamedh Ghat (sunset daily, spectacular, free). Kashi Vishwanath Temple (one of 12 Jyotirlingas, recently renovated corridor, gold dome). Assi Ghat (academic/cultural hub, Subah-e-Banaras morning aarti). Manikarnika Ghat (main cremation ghat, 24/7). Sarnath (10 km, where Buddha gave first sermon, Dhamek Stupa, archaeological museum). Ramnagar Fort (across river, museum, vintage cars). Banaras Hindu University (largest residential university in Asia, Bharat Kala Bhavan museum). Boat ride at sunrise (essential, Rs. 200-400/hr).",
        "weather": "Summer up to 45C (Mar-Jun). Monsoon Jul-Sep (humid, heavy). Winter Oct-Feb cold (5-20C, foggy mornings). Best Oct-Mar (though winter mornings foggy until noon). Mahashivratri (Feb-Mar) huge festival. Dev Deepavali (Nov, Kartik Purnima) spectacular, millions of diyas on ghats.",
        "shopping": "Banarasi Silk Sarees (world famous, gold/zari work, Rs. 2000-lakhs). Handloom carpets (Banarasi carpets, silk/wool). Wooden toys from Kashi. Brassware and copperware. Glass bead jewelry. Fragrances/attars (traditional perfumes). Paan and tobacco products. Vishwanath Gali for silk. Thatheri Bazaar for brass. Godowlia for everything.",
        "transport": "Lal Bahadur Shastri International Airport (VNS) 25 km. Varanasi Junction Railway Station 5 km (well-connected to all major cities). Bus stand 3 km. Auto-rickshaws, cycle rickshaws (primary local transport). Taxis, Ola/Uber limited. Boats for crossing Ganga and ghat tours.",
        "nearby": "Sarnath (10 km). Ramnagar Fort (15 km across river). Prayagraj/Allahabad (120 km, Triveni Sangam, Kumbh Mela site). Chunar Fort (45 km, ancient, Akbar era). Jaunpur (60 km, Atala Mosque, Shahi Bridge). Bodh Gaya (230 km, Mahabodhi Temple, Buddha's enlightenment).",
    },
    {
        "name": "Amritsar", "state": "Punjab", "district": "Amritsar",
        "desc": "Spiritual and cultural heart of Sikhism. Golden Temple (Harmandir Sahib). Jallianwala Bagh tragedy. Famous for Punjab's vibrant culture, cuisine.",
        "cuisine": "Amritsari Kulcha (stuffed bread, top at Bharawan Da Dhaba for chole). Amritsari Fish (tandoori spiced fish, famous since 1914 at Makhan Fish). Lassi at Kanha's (since 1930s, thick creamy, large cups). Chole Bhature. Paneer Tikka. Langar at Golden Temple (free community meal, largest in world, 100K+ meals daily). Kheer at Gurdas Ram. Guru Da Daulat (winter thandai-like dessert). Kangan (since 1915) for traditional thali.",
        "attractions": "Golden Temple (Harmandir Sahib, most sacred Sikh shrine, gold-plated, surrounded by Amrit Sarovar tank, 24-hour chanting, free langar 24/7, must cover head/remove shoes). Jallianwala Bagh (memorial of 1919 massacre, bullet marks preserved). Partition Museum (moving exhibits, Rs. 50). Wagah Border (30 km, daily flag-lowering ceremony at sunset, patriotic fervor, grand show, free). Gobindgarh Fort (historic Sikh fort, sound/light show, Rs. 150). Durgiana Temple (similar architecture to Golden Temple, Hindu temple). Ram Bagh Gardens (summer palace of Maharaja Ranjit Singh).",
        "weather": "Summer up to 45C (Apr-Jun). Monsoon Jul-Sep moderate. Winter 0-20C (Nov-Feb, foggy, can be freezing mornings). Best Oct-Mar (pleasant, though Jan cold). Baisakhi festival Apr 13 (Sikh New Year, harvest, Golden Temple decorated, processions).",
        "shopping": "Punjabi juttis (handcrafted leather shoes, embroidery). Phulkari dupattas (traditional Punjabi embroidery). Papads and pickles. Spices (Amritsari masala blends). Dry fruits (Hall Bazaar, wholesale). Carpets and rugs. Sari and fabric shopping at Katra Jaimal Singh. Hall Bazaar and Guru Bazaar for everything.",
        "transport": "Sri Guru Ram Dass Jee International Airport (ATQ) 12 km. Amritsar Railway Station 2 km (Shatabdi Express 5hr from Delhi). Bus stand 3 km. Auto-rickshaws, cycle rickshaws, taxis. Ola/Uber available. Town is walkable in central areas.",
        "nearby": "Wagah Border (30 km). Goindwal Sahib (40 km, 84-step pilgrimage). Tarn Taran Sahib (22 km, largest sarovar). Harike Wetland (55 km, bird sanctuary). Pathankot (110 km, gateway to Jammu). Dharamshala/McLeod Ganj (150 km, Dalai Lama's residence).",
    },
    {
        "name": "Lucknow", "state": "Uttar Pradesh", "district": "Gomti Nagar",
        "desc": "City of Nawabs and Kebabs. Capital of Awadh region. Known for refined culture, etiquette (Tehzeeb), architecture, cuisine, and chikankari embroidery.",
        "cuisine": "Awadhi cuisine: Galouti Kebab (melt-in-mouth, minced, Tunday Kababi since 1905). Kakori Kebab (minced meat on seekh). Biryani (Awadhi style, layered, aromatic). Nihari (slow-cooked stew). Kulcha Nihari. Shahi Tukda (royal bread pudding). Kulfi Faluda. Basket Chaat (unique Lucknow). Paranthe at Pandit ji. Mutton Curry at Idris ki Biryani. Chai at Royal Cafe. Prakash Kulfi for kulfi. Tunday Kababi (legendary, Aminabad). Dastarkhwan for Awadhi thali.",
        "attractions": "Bara Imambara (1784, central hall largest arched hall in world, Bhulbhulaiya maze, Stepwell, Rs. 50). Chhota Imambara (Hussainabad Imambara, golden dome, mirror work, chandeliers). Rumi Darwaza (imposing 60ft gateway, Turkish influence). Lucknow Zoo (one of oldest in India). British Residency (1857 mutiny ruins). La Martiniere College (Gothic architecture). Bada Ganpati Temple. Ambedkar Memorial Park (impressive modern monument). Janeshwar Mishra Park (largest park in Asia).",
        "weather": "Summer up to 45C (Apr-Jun). Monsoon moderate. Winter Nov-Feb cool (5-25C, foggy). Best Oct-Mar. Lucknow Festival in Jan-Feb showcases culture, crafts, cuisine.",
        "shopping": "Chikankari (intricate shadow-work embroidery on fabric, Lucknow's signature craft). Best at Chowk, Aminabad, and Janpath Market. Ittar/perfumes (traditional attars). Brassware and metalwork. Lacquerware. Zardozi embroidery. Silver jewelry. Nakhas (flea market, antiques, books). Hazratganj (modern retail, brands, restaurants). Chowk (old city, traditional).",
        "transport": "Chaudhary Charan Singh International Airport (LKO) 15 km. Lucknow Charbagh Railway Station (beautiful architecture). Bus stand 5 km. Auto-rickshaws, cycle rickshaws. Ola/Uber available. Metro (growing network). Ekka (horse-drawn carriage, heritage).",
        "nearby": "Ayodhya (130 km, Lord Rama birthplace, Ram Mandir). Kanpur (80 km). Allahabad/Prayagraj (200 km, Triveni Sangam). Varanasi (280 km). Naimisharanya (110 km, ancient pilgrimage site). Unnao (60 km, ancient Buddhist sites).",
    },
    {
        "name": "Manali", "state": "Himachal Pradesh", "district": "Manali",
        "desc": "Honeymoon capital of India. Scenic hill station in Kullu Valley at 2050m. Pine forests, snow-capped peaks, Beas River. Adventure sports hub: skiing, trekking, paragliding, river rafting.",
        "cuisine": "Himachali cuisine: Dham (traditional festive meal, rice, call, chana dal, kaddu ka khatta). Siddu (steamed wheat bread, stuffed). Trout fish (fresh from Beas, grilled, tandoori. Chana Madra (chickpea-yogurt curry). Babru (black gram stuffed puris). Aktori (buckwheat pancake). Apple products (apple juice, cider, wine). Cafe 1947 (German baker, riverside). Drifter's Cafe. The Lazy Dog Lounge. People Art Cafe for Israeli/Mexican.",
        "attractions": "Solang Valley (14 km, skiing Jan-Feb, paragliding, zorbing, cable car Rs. 1500 round). Rohtang Pass (51 km, 3978m, snow sports, scenic, permits needed, closed Oct-May, crowded). Hadimba Devi Temple (16th-century, wooden, surrounded by deodar forest). Manu Temple (dedicated to Manu, progenitor of humans). Van Vihar (riverside park, boating). Old Manali (hippie cafes, guesthouses, bohemian vibe). Vashisht Hot Springs (natural sulphur springs, temlpes). Great Himalayan National Park (UNESCO, trekking, wildlife, 2hr drive entry). Jogini Falls (trek 3km). Museum of Himachal Culture & Folk Art. Mall Road (Gandhi Chowk, shops, restaurants). Beas River rafting (Apr-Jun, Grade 2-3).",
        "weather": "Summer 15-30C (Apr-Jun, best season, snow melts, flowers bloom). Monsoon Jul-Sep heavy (landslide risk). Winter Oct-Mar very cold (0-15C, heavy snow Dec-Feb), Rohtang closed. Dec-Jan snow (magical, Christmas/New Year peak). Best times: Apr-Jun and Dec-Jan.",
        "shopping": "Handicrafts: namda (felted wool rugs), kullu shawls/hats, pashmina, Tibetan items (prayer flags, singing bowls). Himachali topis (caps). Apple products (juice, jams, cider). Trout fish. Woolens. Mall Road, Old Manali, Tibetan Market.",
        "transport": "Kullu-Bhuntar Airport (80 km, limited flights, weather-dependent). Nearest major railway: Chandigarh (310 km). Well-connected by bus from Delhi (530 km, 12hr Volvo AC buses). HRTC buses. Private taxis. Local: walking (Old Manali), autos, taxis, shared buses.",
        "nearby": "Kullu (40 km, Dussehra festival). Naggar Castle (20 km, 1460, art gallery). Manikaran (45 km, hot springs, Gurudwara, Ram temple). Rohtang Pass (51 km). Great Himalayan National Park (50 km to entry). Leh via Rohtang (long journey, spectacular). Kasol (80 km, mini-Israel, Parvati Valley, cafes, trek to Kheerganga).",
    },
    {
        "name": "Ooty", "state": "Tamil Nadu", "district": "Nilgiris",
        "desc": "Queen of Hill Stations. At 2240m in Nilgiri Hills (Blue Mountains). Tea gardens, colonial bungalows, botanical gardens. Nilgiri Mountain Railway (UNESCO toy train).",
        "cuisine": "South Indian staples with colonial Anglo-Indian influence. Varkey biscuits (local bakery specialty). Ooty homemade chocolates (famous,多家 shops). Fresh tea from Nilgiri plantations. Steaming momos (Tibetan influence). Wilks Park Restaurant (heritage dining). Shinkows Chinese (historic). Modern Cafe (since 1920s, coffee house). Kingstar for chocolates. Savalan for cakes.",
        "attractions": "Nilgiri Mountain Railway (Toy Train, Mettupalayam to Ooty, 5hr, UNESCO World Heritage, steam engine, breathtaking views through forest tea gardens, Rs. 275). Botanical Gardens (22 acres, 1858, 1000+ species, flower show May, fossil tree 20M yrs). Ooty Lake (artificial, 1824, boating, Rs. 60 entry). Doddabetta Peak (2630m, highest in Nilgiris, 10km, telescope, panoramic view Rs. 20). Tea Museum/Factory (Doddabetta area, free tasting). Deer Park. Rose Garden (largest in India, 20000+ varieties). Ooty Golf Course (heritage). Thread Garden (intricate display). Pykara Waterfalls & Lake (22 km, spectacular, boating). Avalanche Lake (25 km, pristine, trout fishing, green meadows). Pine Forest (spotted, photography magic).",
        "weather": "Pleasant year-round. Summer 15-25C (Mar-Jun, ideal). Monsoon Jun-Sep (cold, misty, heavy). Winter Oct-Feb cold (5-15C, mornings 2-5C). Frost common in Dec-Jan. Best times: Mar-Jun and Oct-Nov.",
        "shopping": "Homemade chocolates (must-buy, 多家 shops on Commercial Road). Nilgiri tea (all varieties, tea estates direct). Eucalyptus oil. Ooty caraway (spice). Woolens (shmating, shawls). Handicrafts (silver oak wood, bamboo). Fruits (fresh strawberries, plums, peaches Jan-Mar). Kingstar Chocolates. Modern Stores. Government Handicrafts Emporium. Tibetan Market (bargain). Coonoor (20 km, cheaper tea, fewer crowds).",
        "transport": "Nearest airport: Coimbatore (90 km, 3hr). Nearest railway: Mettupalayam (40 km) connecting to Ooty via Toy Train, or Coimbatore. Well-connected by road from Coimbatore, Mysore, Bangalore. Night buses from Bangalore/Chennai. Local: taxis, autos, shared jeeps. Walking for town center.",
        "nearby": "Coonoor (20 km, easier charm, tea gardens, Sims Park, Dolphin's Nose viewpoint). Kotagiri (30 km, offbeat, Catherine Falls, Kodanad Viewpoint). Mudumalai National Park (110 km, tiger reserve, elephant safari). Bandipur NP (120 km). Kodaikanal (200 km, sister hill station). Mettupalayam (40 km, start of Toy Train).",
    },
]

# ── Property definitions ──

PROPERTY_DEFS = [
    # (name, prop_type, city_idx, address, amenities_dict, [rooms...])
    # Each room: (room_type, base_price, adults, children, quantity)

    # Delhi properties (city 4)
    ("The Imperial Palace", "hotel", 4, "1, Janpath, New Delhi, Delhi",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "laundry": True, "room_service": True},
     [("Deluxe", 8000, 2, 1, 20), ("Suite", 15000, 3, 1, 10), ("Presidential", 35000, 4, 2, 2)]),

    ("Haveli Heritage Delhi", "heritage", 4, "15, Hauz Khas Village, New Delhi, Delhi",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True},
     [("Standard", 3500, 2, 0, 8), ("Heritage", 5000, 2, 1, 6)]),

    # Agra properties (city 5)
    ("The Grand Palace", "hotel", 5, "42, Fatehabad Road, Agra, Uttar Pradesh",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True},
     [("Standard", 5000, 2, 1, 25), ("Deluxe", 7500, 2, 1, 15), ("Suite", 12000, 3, 2, 5)]),

    ("Taj View Boutique", "hotel", 5, "18, East Gate, Tajganj, Agra, Uttar Pradesh",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "laundry": True},
     [("Standard", 3000, 2, 0, 10), ("Deluxe Taj View", 5500, 2, 1, 8)]),

    # Jaipur properties (city 0)
    ("Jaipur Royal Retreat", "heritage", 0, "25, C Scheme, Jaipur, Rajasthan",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "spa": True, "ac": True, "laundry": True},
     [("Royal", 8000, 2, 1, 10), ("Maharaja", 15000, 3, 2, 5), ("Imperial", 25000, 4, 2, 3)]),

    ("Pink City Homestay", "homestay", 0, "7, Bani Park, Jaipur, Rajasthan",
     {"wifi": True, "parking": True, "ac": True, "kitchen": True, "laundry": True},
     [("Standard", 2000, 2, 0, 4), ("Family", 3500, 4, 2, 2)]),

    # Udaipur properties (city 1)
    ("Lake Palace Resort", "hotel", 1, "Lake Pichola, Udaipur, Rajasthan",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "boat_service": True},
     [("Deluxe Lake View", 10000, 2, 1, 12), ("Suite", 20000, 3, 2, 6), ("Royal Suite", 45000, 4, 2, 2)]),

    ("Udaipur Boutique Haveli", "heritage", 1, "12, Hanuman Ghat, Udaipur, Rajasthan",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "rooftop": True},
     [("Heritage", 4500, 2, 1, 6), ("Premier", 7000, 3, 1, 4)]),

    # Jodhpur properties (city 2)
    ("Blue City Palace", "hotel", 2, "55, Circuit House Road, Jodhpur, Rajasthan",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "bar": True, "ac": True, "laundry": True},
     [("Standard", 4000, 2, 0, 15), ("Deluxe", 6500, 2, 1, 10), ("Suite", 11000, 3, 1, 5)]),

    ("Jodhpur Heritage Stay", "heritage", 2, "8, Navchokiya, Jodhpur, Rajasthan",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True},
     [("Heritage", 3000, 2, 0, 6), ("Deluxe", 5000, 2, 1, 4)]),

    # Jaisalmer properties (city 3)
    ("Golden Desert Camp", "resort", 3, "Sam Sand Dunes, Jaisalmer, Rajasthan",
     {"wifi": True, "parking": True, "restaurant": True, "campfire": True, "cultural_show": True, "camel_safari": True},
     [("Desert Tent", 5000, 2, 1, 15), ("Royal Tent", 8000, 3, 1, 8), ("Suite Camp", 15000, 4, 2, 4)]),

    ("Jaisalmer Fort View Hotel", "hotel", 3, "10, Fort Road, Jaisalmer, Rajasthan",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "rooftop": True},
     [("Standard", 2500, 2, 0, 10), ("Deluxe Fort View", 4500, 2, 1, 6)]),

    # Rishikesh properties (city 6)
    ("Ganga Riverside Ashram", "resort", 6, "Tapovan, Rishikesh, Uttarakhand",
     {"wifi": True, "parking": True, "restaurant": True, "yoga": True, "meditation_hall": True, "river_access": True, "ac": True},
     [("Standard", 3000, 2, 0, 12), ("River View", 5000, 2, 1, 8), ("Suite", 8000, 3, 1, 4)]),

    ("Rishikesh Adventure Lodge", "hostel", 6, "45, Laxman Jhula Road, Rishikesh, Uttarakhand",
     {"wifi": True, "parking": True, "restaurant": True, "campfire": True, "rafting_packages": True},
     [("Dormitory", 800, 1, 0, 20), ("Private", 2000, 2, 0, 8), ("Cottage", 4000, 3, 1, 4)]),

    # Goa properties (city 7)
    ("Paradise Beach Resort", "resort", 7, "Calangute Beach, North Goa, Goa",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "beach_access": True, "water_sports": True},
     [("Standard", 6000, 2, 1, 20), ("Deluxe Sea View", 9000, 2, 1, 12), ("Villa", 20000, 4, 2, 4)]),

    ("Goa Portuguese Villa", "homestay", 7, "3, Fontainhas, Panjim, Goa",
     {"wifi": True, "parking": True, "kitchen": True, "ac": True, "garden": True},
     [("Heritage Room", 4000, 2, 0, 4), ("Family Suite", 7000, 4, 1, 2)]),

    # Mumbai properties (city 8)
    ("Sea Rock Executive", "hotel", 8, "100, Marine Drive, Mumbai, Maharashtra",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "laundry": True, "business_center": True},
     [("Deluxe", 10000, 2, 1, 30), ("Executive", 18000, 3, 1, 15), ("Penthouse", 50000, 4, 2, 3)]),

    ("Mumbai Budget Inn", "hostel", 8, "22, Colaba Causeway, Mumbai, Maharashtra",
     {"wifi": True, "ac": True, "laundry": True, "common_kitchen": True},
     [("Dormitory", 1200, 1, 0, 30), ("Private Single", 2500, 1, 0, 8), ("Private Double", 3500, 2, 0, 6)]),

    # Pune properties (city 9)
    ("Pune Vineyard Retreat", "resort", 9, "12, Koregaon Park, Pune, Maharashtra",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "garden": True, "yoga": True},
     [("Garden Room", 5500, 2, 0, 12), ("Vineyard Suite", 9000, 3, 1, 8), ("Royal Villa", 18000, 4, 2, 3)]),

    ("Pune Executive Stay", "hotel", 9, "88, MG Road, Pune, Maharashtra",
     {"wifi": True, "parking": True, "restaurant": True, "gym": True, "ac": True, "laundry": True, "business_center": True},
     [("Standard", 3500, 2, 0, 12), ("Executive", 5500, 2, 1, 8)]),

    # Bangalore properties (city 10)
    ("Garden City Tech Hotel", "hotel", 10, "55, MG Road, Bangalore, Karnataka",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "business_center": True, "co_working": True},
     [("Standard", 5500, 2, 0, 25), ("Deluxe", 9000, 2, 1, 15), ("Smart Suite", 16000, 3, 1, 8)]),

    ("Bangalore Garden Homestay", "homestay", 10, "30, Indiranagar, Bangalore, Karnataka",
     {"wifi": True, "parking": True, "kitchen": True, "ac": True, "garden": True, "laundry": True},
     [("Standard", 2500, 2, 0, 4), ("Family", 4500, 4, 2, 3)]),

    # Chennai properties (city 11)
    ("Chennai Sea Breeze Hotel", "hotel", 11, "1, Marina Beach Road, Chennai, Tamil Nadu",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "bar": True, "ac": True, "laundry": True},
     [("Standard", 4000, 2, 0, 18), ("Sea View", 7000, 2, 1, 10), ("Suite", 12000, 3, 1, 5)]),

    ("Chennai Budget Lodge", "hostel", 11, "65, Mount Road, Chennai, Tamil Nadu",
     {"wifi": True, "ac": True, "laundry": True, "cafe": True},
     [("Dormitory", 1000, 1, 0, 20), ("Private", 2000, 2, 0, 8)]),

    # Hyderabad properties (city 12)
    ("Hyderabad Pearl Continental", "hotel", 12, "77, Jubilee Hills, Hyderabad, Telangana",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "bar": True, "ac": True, "business_center": True},
     [("Standard", 4500, 2, 0, 20), ("Deluxe", 8000, 2, 1, 12), ("Pearl Suite", 16000, 3, 1, 5)]),

    ("Hyderabad Heritage House", "homestay", 12, "23, Old City, Hyderabad, Telangana",
     {"wifi": True, "parking": True, "ac": True, "kitchen": True, "laundry": True},
     [("Standard", 2000, 2, 0, 4), ("Deluxe", 3500, 2, 1, 3)]),

    # Kolkata properties (city 13)
    ("Kolkata Grand Hotel", "hotel", 13, "11, Park Street, Kolkata, West Bengal",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "bar": True, "ac": True, "laundry": True, "business_center": True},
     [("Standard", 4000, 2, 0, 20), ("Deluxe", 7000, 2, 1, 12), ("Suite", 14000, 3, 2, 6)]),

    ("Kolkata Riverside Lodge", "hostel", 13, "3, Princep Ghat, Kolkata, West Bengal",
     {"wifi": True, "restaurant": True, "ac": True, "laundry": True, "river_view": True},
     [("Dormitory", 900, 1, 0, 16), ("Private", 2200, 2, 0, 6)]),

    # Kochi properties (city 14)
    ("Kochi Harbor View", "hotel", 14, "10, Fort Kochi, Kochi, Kerala",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "spa": True, "ayurveda_center": True, "ac": True, "laundry": True},
     [("Standard", 4500, 2, 0, 15), ("Harbor Suite", 8500, 3, 1, 8), ("Penthouse", 18000, 4, 2, 3)]),

    ("Kerala Backwaters Houseboat", "resort", 14, "Alleppey Jetty, Alleppey, Kerala",
     {"wifi": True, "kitchen": True, "ac": True, "dining_deck": True, "sun_deck": True, "cruise": True},
     [("Houseboat Standard", 6000, 2, 1, 10), ("Houseboat Premium", 12000, 3, 1, 6), ("Royal Houseboat", 25000, 4, 2, 3)]),

    # Munnar properties (city 15)
    ("Munnar Tea Garden Resort", "resort", 15, "Chithirapuram, Munnar, Kerala",
     {"wifi": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "ac": True, "garden": True, "tea_tasting": True, "trekking": True},
     [("Tea Garden View", 5000, 2, 0, 12), ("Premium Villa", 10000, 3, 1, 6), ("Heritage Suite", 18000, 4, 2, 3)]),

    # Coorg properties (city 16)
    ("Coorg Coffee Plantation Resort", "resort", 16, "48, Madikeri, Coorg, Karnataka",
     {"wifi": True, "parking": True, "restaurant": True, "spa": True, "ac": True, "garden": True, "campfire": True, "coffee_tasting": True, "nature_trek": True, "bonfire": True},
     [("Coffee Estate Room", 4500, 2, 0, 10), ("Plantation Suite", 8000, 3, 1, 6), ("Luxury Treehouse", 15000, 4, 2, 2)]),

    # Mysore properties (city 17)
    ("Mysore Palace Inn", "hotel", 17, "5, Temple Road, Mysore, Karnataka",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "ac": True, "laundry": True},
     [("Standard", 3000, 2, 0, 12), ("Deluxe", 5500, 2, 1, 8), ("Palace Suite", 11000, 3, 1, 4)]),

    # Pondicherry properties (city 18)
    ("Pondicherry French Quarter Hotel", "heritage", 18, "22, Rue Romain Rolland, White Town, Pondicherry",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "garden": True, "laundry": True, "courtyard": True},
     [("Standard", 3500, 2, 0, 8), ("French Suite", 6500, 2, 1, 6), ("Colonial Villa", 12000, 4, 2, 3)]),

    ("Pondicherry Beach House", "homestay", 18, "7, Promenade Beach Road, Pondicherry",
     {"wifi": True, "parking": True, "kitchen": True, "ac": True, "terrace": True, "sea_view": True},
     [("Standard", 2800, 2, 0, 4), ("Beach View", 5000, 2, 1, 2)]),

    # Darjeeling properties (city 19)
    ("Darjeeling Himalayan Retreat", "resort", 19, "8, Mall Road, Darjeeling, West Bengal",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "laundry": True, "garden": True, "kanchenjunga_view": True, "tea_lounge": True},
     [("Standard", 4000, 2, 0, 10), ("Himalayan View", 7000, 2, 1, 6), ("Suite", 14000, 3, 1, 4)]),

    # Gangtok properties (city 20)
    ("Gangtok Mountain View Hotel", "hotel", 20, "MG Marg, Gangtok, Sikkim",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "laundry": True, "garden": True, "mountain_view": True, "bonfire": True},
     [("Standard", 3500, 2, 0, 12), ("Mountain View", 6000, 2, 1, 8), ("Deluxe Suite", 12000, 3, 1, 4)]),

    # Varanasi properties (city 21)
    ("Varanasi Ghat Serenity Hotel", "hotel", 21, "15, Dashashwamedh Ghat, Varanasi, Uttar Pradesh",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "laundry": True, "rooftop": True, "boat_service": True},
     [("Standard", 2500, 2, 0, 10), ("Ganga View", 4500, 2, 1, 8), ("Suite", 8000, 3, 1, 4)]),

    ("Varanasi Spiritual Ashram", "hostel", 21, "32, Assi Ghat, Varanasi, Uttar Pradesh",
     {"wifi": True, "restaurant": True, "ac": True, "yoga": True, "meditation_room": True, "rooftop": True},
     [("Dormitory", 600, 1, 0, 20), ("Private Room", 1500, 2, 0, 6)]),

    # Amritsar properties (city 22)
    ("Amritsar Golden Temple View Hotel", "hotel", 22, "5, Heritage Street, Amritsar, Punjab",
     {"wifi": True, "parking": True, "restaurant": True, "ac": True, "laundry": True, "rooftop": True, "gurdwara_view": True},
     [("Standard", 2800, 2, 0, 14), ("Deluxe", 5000, 2, 1, 8), ("Golden View Suite", 9000, 3, 1, 4)]),

    # Lucknow properties (city 23)
    ("Lucknow Nawab's Palace Hotel", "heritage", 23, "18, Hazratganj, Lucknow, Uttar Pradesh",
     {"wifi": True, "pool": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "ac": True, "laundry": True, "garden": True},
     [("Standard", 3500, 2, 0, 12), ("Nawabi Suite", 7000, 2, 1, 6), ("Maharaja Suite", 15000, 4, 2, 2)]),

    ("Lucknow Chikankari Homestay", "homestay", 23, "55, Gomti Nagar, Lucknow, Uttar Pradesh",
     {"wifi": True, "parking": True, "ac": True, "kitchen": True, "garden": True, "laundry": True},
     [("Standard", 2000, 2, 0, 4), ("Family Room", 3500, 4, 1, 2)]),

    # Manali properties (city 24)
    ("Manali Snow Peak Resort", "resort", 24, "22, Old Manali Road, Manali, Himachal Pradesh",
     {"wifi": True, "parking": True, "restaurant": True, "gym": True, "spa": True, "ac": True, "fireplace": True, "snow_activities": True, "bonfire": True},
     [("Standard", 4000, 2, 0, 15), ("Snow View", 7000, 2, 1, 10), ("Premium Chalet", 15000, 4, 2, 5)]),

    ("Manali Backpackers Hostel", "hostel", 24, "10, Vashisht Road, Manali, Himachal Pradesh",
     {"wifi": True, "restaurant": True, "campfire": True, "common_room": True, "kitchen": True},
     [("Dormitory", 800, 1, 0, 24), ("Private", 1800, 2, 0, 6), ("Cottage", 3500, 3, 1, 4)]),

    # Ooty properties (city 25)
    ("Ooty Lake View Resort", "resort", 25, "12, Lake Road, Ooty, Tamil Nadu",
     {"wifi": True, "parking": True, "restaurant": True, "gym": True, "ac": True, "fireplace": True, "garden": True, "bonfire": True},
     [("Standard", 3500, 2, 0, 12), ("Lake View", 6000, 2, 1, 8), ("Premium Suite", 12000, 3, 1, 4)]),

    ("Ooty Tea Estate Cottage", "homestay", 25, "5, Doddabetta Road, Ooty, Tamil Nadu",
     {"wifi": True, "parking": True, "kitchen": True, "fireplace": True, "garden": True, "laundry": True},
     [("Cottage", 3000, 2, 0, 4), ("Family Cottage", 5500, 4, 2, 2)]),

    # Extra properties for variety
    ("Jaipur Pink Paradise", "homestay", 0, "33, Bani Park, Jaipur, Rajasthan",
     {"wifi": True, "parking": True, "ac": True, "kitchen": True, "garden": True, "laundry": True, "rooftop": True},
     [("Standard", 1800, 2, 0, 4), ("Deluxe", 3000, 2, 1, 3)]),

    ("Goa Beach Shack", "homestay", 7, "Palolem Beach, South Goa, Goa",
     {"wifi": True, "restaurant": True, "ac": True, "beach_access": True, "hammocks": True},
     [("Beach Hut", 2500, 2, 0, 8), ("Premium Hut", 4500, 2, 1, 4)]),

    ("Udaipur Lake View Homestay", "homestay", 1, "5, Ambavgarh, Udaipur, Rajasthan",
     {"wifi": True, "parking": True, "ac": True, "kitchen": True, "rooftop": True, "lake_view": True},
     [("Standard", 2200, 2, 0, 3), ("Lake View", 4000, 2, 1, 2)]),

    ("Kolkata Art Deco Hotel", "heritage", 13, "15, Sudder Street, Kolkata, West Bengal",
     {"wifi": True, "restaurant": True, "ac": True, "laundry": True, "garden": True, "art_gallery": True},
     [("Standard", 2800, 2, 0, 8), ("Art Suite", 5500, 2, 1, 4)]),

    ("Mysore Heritage Bungalow", "homestay", 17, "22, Jayalakshmipuram, Mysore, Karnataka",
     {"wifi": True, "parking": True, "kitchen": True, "ac": True, "garden": True, "laundry": True, "breakfast": True},
     [("Standard", 2500, 2, 0, 4), ("Bungalow Suite", 5000, 4, 2, 2)]),

    ("Rishikesh Yoga Retreat", "resort", 6, "17, Tapovan, Rishikesh, Uttarakhand",
     {"wifi": True, "restaurant": True, "ac": True, "yoga_deck": True, "meditation_cave": True, "organic_garden": True, "ganga_access": True},
     [("Standard", 2500, 2, 0, 8), ("Yoga Suite", 4500, 2, 0, 4), ("Cottage", 7000, 3, 1, 3)]),
]

# ── Document text generators (produce rich, long-form content for chunking) ──

def _gen_cancellation_policy(prop_name, city):
    c = CITY_PROFILES[city]
    return (
        f"{prop_name} — Cancellation Policy\n\n"
        f"We understand that travel plans can change. {prop_name} in {c['name']}, {c['state']}, "
        f"offers a flexible cancellation policy designed to accommodate our guests' needs while ensuring "
        f"fair treatment of our staff and the property.\n\n"
        f"FREE CANCELLATION (Full Refund):\n"
        f"Cancellations made 7 or more days before the scheduled check-in date will receive a full refund "
        f"of the entire booking amount, with no cancellation fees. This gives our guests complete peace of "
        f"mind when booking their stay in {c['name']}. {c['desc']}\n\n"
        f"PARTIAL REFUND:\n"
        f"Cancellations made between 3 and 6 days before check-in will receive a 50% refund of the total "
        f"booking amount. The remaining 50% covers administrative costs and compensates for the lost "
        f"opportunity to rebook the room, especially important during peak tourist seasons when we receive "
        f"many inquiries from travelers eager to experience {c['name']} and its famous attractions.\n\n"
        f"Cancellations made between 24 hours and 48 hours before check-in will receive a 25% refund.\n\n"
        f"NO REFUND:\n"
        f"Cancellations made less than 24 hours before check-in, or no-shows without any cancellation notice, "
        f"will not receive any refund. In case of early check-out, no refund will be provided for the unused nights.\n\n"
        f"EXCEPTIONS:\n"
        f"We understand that medical emergencies and unforeseen circumstances can occur. In such cases, "
        f"please contact our front desk team directly. We review exceptional circumstances on a case-by-case "
        f"basis and may offer full refunds or future stay credits at our discretion. Documentation may be "
        f"required for medical emergencies.\n\n"
        f"HOW TO CANCEL:\n"
        f"Cancellations can be made through your online booking portal, by emailing our reservations team, "
        f"or by calling our front desk. Please have your booking reference number ready for faster processing. "
        f"Refunds are processed within 7-10 business days and will be credited to the original payment method "
        f"used at the time of booking.\n\n"
        f"GROUP BOOKINGS:\n"
        f"For groups of 5 or more rooms, a different cancellation policy applies. Please contact our group "
        f"sales department for details. Generally, group bookings require 14 days advance cancellation notice "
        f"for a full refund, and 50% refund for cancellations between 7-13 days before arrival.\n\n"
        f"PEAK SEASON:\n"
        f"During major festivals, holidays, and special events in {c['name']} such as {c['shopping'][:100]}..., "
        f"a stricter cancellation policy may apply. We recommend purchasing travel insurance for bookings "
        f"during these periods. Our team will inform you of any special policy variations at the time of booking.\n\n"
        f"Cancellation policies are designed to balance flexibility for our guests with the operational "
        f"realities of running a hospitality business. We strive to be fair and reasonable in all our "
        f"dealings, and our front desk team is always ready to assist with any special circumstances. "
        f"The weather in {c['name']} can be unpredictable — {c['weather'][:150]} during which we may "
        f"offer additional flexibility."
    )


def _gen_house_rules(prop_name, city):
    c = CITY_PROFILES[city]
    return (
        f"{prop_name} — House Rules\n\n"
        f"To ensure a comfortable and enjoyable stay for all our guests at {prop_name} in {c['name']}, "
        f"We ask that you kindly follow these house rules. {c['desc']} We take pride in maintaining "
        f"a clean, safe, and welcoming environment for everyone who visits our beautiful property.\n\n"
        f"CHECK-IN AND CHECK-OUT:\n"
        f"Check-in time: 2:00 PM. Early check-in requests are subject to availability and may incur "
        f"an additional charge of half the daily room rate. We will do our best to accommodate early "
        f"arrivals whenever possible. Check-out time: 11:00 AM. Late check-out requests must be made "
        f"by 9:00 AM on the day of departure and are subject to availability. Late check-out until "
        f"2:00 PM incurs a charge of 50% of the daily room rate. Check-out after 2:00 PM will be "
        f"charged at the full daily room rate. Luggage storage is complimentary for guests who wish "
        f"to explore {c['name']} after check-out.\n\n"
        f"SMOKING POLICY:\n"
        f"Smoking is strictly prohibited in all indoor areas including guest rooms, corridors, "
        f"lobbies, and restaurants. A fine of Rs. 3000 will be levied for violation of this policy, "
        f"and guests may be asked to vacate the premises without refund. Designated smoking areas "
        f"are available in the outdoor garden, on designated balconies, and in the rooftop lounge. "
        f"Please dispose of cigarette butts responsibly in the sand-filled containers provided. "
        f"The fine also covers the cost of deep cleaning the room, including curtains, carpets, "
        f"and upholstery, which must be done before the room can be reassigned to new guests.\n\n"
        f"QUIET HOURS:\n"
        f"Quiet hours are observed from 10:30 PM to 6:00 AM daily. During this time, please keep "
        f"noise levels to a minimum in all areas of the property. This includes loud conversations, "
        f"televisions, and music. We ask that all guests be considerate of others during these hours. "
        f"Groups celebrating special occasions are welcome but must keep celebration noise at "
        f"reasonable levels, especially after 10 PM. Our staff will remind guests about quiet hours "
        f"if noise levels become excessive.\n\n"
        f"VISITORS:\n"
        f"For security purposes, all visitors must register at the front desk and present valid photo "
        f"identification. Visitors are not permitted in guest rooms after 10:00 PM. All guests are "
        f"requested to inform the front desk if they are expecting visitors. Non-registered guests "
        f"are not allowed to use property amenities including the pool, gym, and spa facilities.\n\n"
        f"POOL AND RECREATION AREAS:\n"
        f"Pool hours are from 6:00 AM to 9:00 PM. Children under 12 must be accompanied by an adult "
        f"at all times. No glass containers are allowed in the pool area. Proper swimwear is required "
        f"— regular clothing is not permitted in the pool. Showers must be taken before entering "
        f"the pool. The pool area is monitored by lifeguards during operating hours. The hotel is "
        f"not responsible for lost or stolen items in recreational areas. Sun loungers may not be "
        f"reserved by placing towels; unattended items will be removed after 30 minutes.\n\n"
        f"PETS:\n"
        f"Pets are allowed only in designated pet-friendly rooms and with a refundable deposit of "
        f"Rs. 2000. Guests must inform the hotel at the time of booking if they plan to bring a pet. "
        f"Pets must be kept on a leash in all common areas and are not permitted in the restaurant, "
        f"pool, or spa areas. Owners are responsible for cleaning up after their pets and for any "
        f"damage caused by the pet. Aggressive behavior from pets will result in immediate removal "
        f"from the property without refund of the pet deposit.\n\n"
        f"DAMAGE AND LIABILITY:\n"
        f"Guests are responsible for any damage caused to property, furniture, or fixtures during "
        f"their stay. Charges for repair or replacement will be applied to the guest's account. "
        f"Rooms are inspected after check-out and any damages discovered will be communicated to "
        f"the guest along with charges. Lost key cards incur a replacement fee of Rs. 500.\n\n"
        f"SAFETY AND SECURITY:\n"
        f"For your safety, please keep your room door locked at all times. The hotel is not "
        f"responsible for valuables left in rooms. Use the in-room safe for important documents, "
        f"jewelry, and cash. Report any suspicious activity to the front desk immediately. Fire "
        f"escape routes are clearly marked on the back of your room door. In case of emergency, "
        f"dial 0 from your room phone to reach the front desk. CCTV cameras are operational in "
        f"all common areas for your security. The local area of {c['name']} is generally safe, "
        f"but we advise guests to take standard precautions when venturing out, especially at night. "
        f"The weather in this region means that during {c['weather'][:100]} we may need to adjust "
        f"certain outdoor activities and amenities for guest safety."
    )


def _gen_local_guide(prop_name, city):
    c = CITY_PROFILES[city]
    return (
        f"{prop_name} — Local Guide to {c['name']}\n\n"
        f"Welcome to {c['name']}, {c['state']}! We at {prop_name} are delighted to help you explore "
        f"this wonderful destination. {c['desc']} Here is our comprehensive guide to making the "
        f"most of your stay, compiled by our local staff who know the city intimately.\n\n"
        f"TOP ATTRACTIONS:\n{c['attractions']}\n\n"
        f"FOOD & DINING:\n{c['cuisine']}\n\n"
        f"WEATHER & BEST TIME TO VISIT:\n{c['weather']}\n\n"
        f"SHOPPING:\n{c['shopping']}\n\n"
        f"NEARBY DESTINATIONS:\n{c['nearby']}\n\n"
        f"LOCAL TIPS FROM OUR STAFF:\n"
        f"1. The best time to visit major attractions in {c['name']} is early morning (before 9 AM) "
        f"to avoid crowds and the afternoon heat. Most popular sites open by 8 AM or earlier.\n"
        f"2. Book popular restaurants in advance, especially on weekends. Local favorites often "
        f"have waiting periods of 30-60 minutes during peak hours.\n"
        f"3. Carry cash for street food, local markets, and auto-rickshaws as many small vendors "
        f"do not accept digital payments or cards.\n"
        f"4. Stay hydrated and carry a reusable water bottle. Many hotels and restaurants offer "
        f"complimentary filtered water refills.\n"
        f"5. Download offline maps of the area before heading out, as some neighborhoods in "
        f"{c['name']} can be confusing to navigate with narrow streets and similar-looking lanes.\n"
        f"6. Respect local customs and dress codes, especially when visiting religious sites. "
        f"Temples, mosques, and gurdwaras typically require covered shoulders and legs, and "
        f"removal of footwear before entering.\n"
        f"7. The local language is primarily {c['state']} languages, but Hindi and English are "
        f"widely understood in tourist areas. Learning a few basic phrases in the local language "
        f"is always appreciated by locals.\n"
        f"8. For transportation, download ride-hailing apps like Ola and Uber which work reliably "
        f"in most parts of the city. Auto-rickshaws may quote higher fares; negotiate before boarding.\n"
        f"9. Photography is allowed at most tourist sites, but some museums and temples have "
        f"restrictions on flash photography and videography. Always check signage before taking pictures.\n"
        f"10. Trust our front desk team for recommendations! We know {c['name']} inside out and "
        f"can suggest hidden gems that most tourists miss. We can also help arrange guides, "
        f"transportation, and special experiences.\n\n"
        f"EMERGENCY CONTACTS:\n"
        f"Police: 100, Ambulance: 108, Fire: 101. The nearest hospital to our property is "
        f"within 5 kilometers. Our front desk is available 24/7 for any assistance you may need "
        f"during your stay."
    )


def _gen_transportation(prop_name, city):
    c = CITY_PROFILES[city]
    return (
        f"{prop_name} — Transportation Guide for {c['name']}\n\n"
        f"This comprehensive guide will help you navigate {c['name']} and its surrounding areas "
        f"during your stay at {prop_name}. {c['desc']}\n\n"
        f"GETTING TO THE HOTEL:\n{c['transport']}\n\n"
        f"GETTING AROUND {c['name'].upper()}:\n"
        f"The city offers multiple transportation options suitable for different budgets and preferences. "
        f"AUTO-RICKSHAWS are the most common form of local transport. Always negotiate the fare before "
        f"starting your journey, or insist on using the meter. From the hotel, you can expect to pay "
        f"Rs. 100-300 for most destinations within the city center. For longer distances or airport "
        f"transfers, we recommend our hotel's pre-paid taxi service for a hassle-free experience with "
        f"fixed, transparent pricing.\n\n"
        f"RIDE-HAILING APPS: Ola and Uber operate extensively in {c['name']} and offer a convenient, "
        f"cashless alternative to auto-rickshaws. You can book a ride directly from the hotel's entrance. "
        f"The apps provide fare estimates before confirming the booking, and you can track your ride in real time. "
        f"During peak hours (8-10 AM and 5-8 PM), surge pricing may apply, and wait times can be longer. "
        f"We recommend allowing extra time for airport transfers during these periods.\n\n"
        f"PUBLIC TRANSPORT: {c['name']} has a developing public transport system. City buses cover most "
        f"routes and are very economical, though they can be crowded during peak hours. Some cities also "
        f"have metro or suburban rail systems that offer fast, air-conditioned travel between major areas. "
        f"Our front desk can provide route maps and guidance on using public transportation.\n\n"
        f"TAXIS: Prepaid taxis are available at the airport, railway station, and major bus stands. "
        f"These offer fixed rates to various destinations in and around the city. Private taxis can be "
        f"hired for full-day or half-day sightseeing tours. Our hotel can arrange reliable taxi services "
        f"with experienced drivers who know the area well and can double as informal guides.\n\n"
        f"WALKING: Many of {c['name']}'s major attractions are within walking distance of each other in "
        f"the central areas. Walking is the best way to discover hidden gems, street food stalls, and "
        f"local markets. However, always stay aware of traffic and use designated pedestrian crossings. "
        f"Some areas have uneven footpaths, so comfortable walking shoes are recommended.\n\n"
        f"CYCLING: In some parts of {c['name']}, bicycle rentals and bike-sharing programs are available. "
        f"This is an eco-friendly way to explore quieter neighborhoods and parks. Our hotel can help "
        f"arrange bicycle rentals for guests who wish to explore at their own pace.\n\n"
        f"CAR RENTAL: Self-drive car rentals are available through services like Zoomcar, Revv, and "
        f"Myles. A valid driver's license (international driving permit for foreign nationals) is required. "
        f"Parking at the hotel is complimentary for registered guests. Driving in {c['name']} can be "
        f"challenging for visitors unfamiliar with local traffic conditions — we recommend hiring a "
        f"driver along with the car for a stress-free experience.\n\n"
        f"INTERCITY TRAVEL:\n"
        f"From {c['name']}, you can explore several nearby destinations. {c['nearby']}\n\n"
        f"For train travel, the Indian Railway network connects {c['name']} to all major cities. "
        f"Our concierge can assist with ticket bookings for express trains, including the luxury tourist "
        f"trains that pass through the region. For air travel, the nearest airport serves domestic and "
        f"selected international destinations. Pre-booked taxis from the hotel to the airport are "
        f"recommended, especially for early morning or late night flights.\n\n"
        f"TRAVEL TIPS:\n"
        f"• Book airport transfers at least 24 hours in advance through our front desk.\n"
        f"• Allow extra travel time during local festivals and peak tourist seasons.\n"
        f"• Keep the hotel's address and phone number written down to show taxi drivers.\n"
        f"• Download ride-hailing apps before your trip and ensure your internet connection works.\n"
        f"• Most transportation services accept both cash and digital payments, but having small "
        f"denomination cash is helpful for auto-rickshaws and local buses.\n"
        f"• The local driving style may seem chaotic to visitors from abroad; we recommend first-time "
        f"visitors use our recommended taxi services rather than self-driving."
    )


def _gen_faq(prop_name, city):
    c = CITY_PROFILES[city]
    return (
        f"{prop_name} — FAQ & Additional Information\n\n"
        f"Frequently Asked Questions about {prop_name} in {c['name']}, {c['state']}.\n"
        f"{c['desc']}\n\n"
        f"Q1: What is the best time to visit {c['name']}?\n"
        f"A: {c['weather']}\n\n"
        f"Q2: What are the must-try local dishes in {c['name']}?\n"
        f"A: {c['cuisine']}\n\n"
        f"Q3: What are the top attractions and how much time do I need?\n"
        f"A: {c['attractions']} We recommend at least 2-3 days to explore the main attractions comfortably. "
        f"Our front desk can help you plan an itinerary based on your interests and available time.\n\n"
        f"Q4: What shopping is {c['name']} famous for?\n"
        f"A: {c['shopping']} Our hotel is conveniently located near major shopping areas. "
        f"We recommend visiting the local markets in the late afternoon or early evening when they "
        f"are most vibrant and atmospheric.\n\n"
        f"Q5: Is {c['name']} safe for solo travelers and families?\n"
        f"A: Yes, {c['name']} is generally considered safe for all types of travelers. As with any "
        f"city, we recommend taking standard precautions: avoid isolated areas at night, keep "
        f"valuables secure, use registered transportation, and stay aware of your surroundings. "
        f"The local police are helpful and tourist-friendly. Our hotel has 24-hour security and "
        f"CCTV surveillance for your peace of mind. Solo female travelers will find the city "
        f"welcoming, with many women-friendly restaurants, shops, and transport options. "
        f"The local community is warm and hospitable, especially when visitors show respect for "
        f"local customs and traditions.\n\n"
        f"Q6: Do you offer airport/station pickup?\n"
        f"A: Yes, we provide pickup and drop services from the airport, railway station, and bus stand. "
        f"Please share your travel details at least 24 hours before arrival so we can arrange the pickup. "
        f"Our drivers will meet you at the arrival gate with a sign displaying your name and our hotel logo. "
        f"The charges depend on the distance and vehicle type. We offer both economy sedans and premium SUVs.\n\n"
        f"Q7: Is breakfast included?\n"
        f"A: Breakfast is complimentary for all guests staying in Deluxe rooms and above. "
        f"Guests in Standard rooms can add breakfast at Rs. 500 per person per day. Our breakfast "
        f"buffet includes a mix of local and international dishes, fresh fruits, juices, and beverages. "
        f"Breakfast is served from 7:00 AM to 10:30 AM on weekdays and until 11:00 AM on weekends. "
        f"We also accommodate special dietary requirements including vegetarian, vegan, gluten-free, "
        f"and Jain meal options with advance notice.\n\n"
        f"Q8: What amenities does the hotel offer?\n"
        f"A: Our hotel features include free WiFi throughout the property, air conditioning, "
        f"24-hour room service, laundry service, restaurant and bar, gym, pool, spa, and more. "
        f"Business travelers can use our business center with printing, scanning, and meeting room facilities. "
        f"We also offer concierge services for tour bookings, transport arrangements, and restaurant reservations.\n\n"
        f"Q9: Can I extend my stay?\n"
        f"A: Extension requests are subject to room availability. Please inform the front desk at "
        f"least 24 hours before your scheduled check-out date. During peak season, early extension "
        f"requests are recommended as rooms fill up quickly. Extension rates may differ from your "
        f"original booking rate, especially during festivals and holidays.\n\n"
        f"Q10: Is the hotel suitable for business travelers?\n"
        f"A: Absolutely. We offer high-speed WiFi, a well-equipped business center with workstations, "
        f"printing and scanning facilities, and meeting rooms that can accommodate up to 30 people. "
        f"Our location in {c['name']} provides easy access to commercial districts and corporate offices. "
        f"We also offer express check-in/check-out and late check-out options for business guests on tight schedules.\n\n"
        f"Q11: What nearby destinations can I visit?\n"
        f"A: {c['nearby']} Day trips can be arranged through our concierge with packed lunches and "
        f"guided tours. Half-day and full-day tours are available for most nearby attractions.\n\n"
        f"Q12: Do you accommodate special occasions?\n"
        f"A: Yes! We specialize in celebrating birthdays, anniversaries, honeymoons, and other special "
        f"occasions. Please inform us at the time of booking so we can arrange cakes, flowers, room "
        f"decorations, or special dining experiences. We offer special honeymoon packages that include "
        f"a romantic room setup, candlelight dinner, and couple spa treatments. Our events team can "
        f"also help organize small gatherings, celebrations, and intimate weddings at our property.\n\n"
        f"Q13: What is the cancellation policy?\n"
        f"A: Our standard cancellation policy offers free cancellation up to 7 days before check-in, "
        f"50% refund between 3-6 days, 25% refund between 24-48 hours, and no refund for cancellations "
        f"within 24 hours or no-shows. Special policies apply during peak seasons and festivals. "
        f"We recommend reviewing the full policy at the time of booking.\n\n"
        f"Q14: Are group bookings available?\n"
        f"A: Yes, we welcome group bookings for family reunions, corporate retreats, and tour groups. "
        f"Please contact our group sales department for special rates and customized packages. "
        f"We offer discounted rates for groups of 5 or more rooms, along with complimentary services "
        f"such as group airport transfers and welcome refreshments.\n\n"
        f"Q15: What languages do your staff speak?\n"
        f"A: Our multilingual staff speaks English, Hindi, and the local state language(s) fluently. "
        f"We also have staff members who speak additional regional languages to assist guests from "
        f"different parts of India. For international guests, we can arrange interpretation services "
        f"with advance notice for languages such as French, German, Spanish, Japanese, Chinese, "
        f"Arabic, and Russian."
    )


# ── Build DOCUMENTS dict at module load time ──

_DOCUMENT_TYPES = [
    ("cancellation_policy", "Cancellation Policy", _gen_cancellation_policy),
    ("house_rules", "House Rules", _gen_house_rules),
    ("transportation", "Transportation", _gen_transportation),
    ("local_guide", "Local Guide", _gen_local_guide),
    ("other", "FAQ & Additional Information", _gen_faq),
]

PROPERTIES = []
DOCUMENTS = {}

for pidx, pdef in enumerate(PROPERTY_DEFS):
    name, ptype, city_idx, addr, amenities, rooms = pdef
    city_name = CITY_PROFILES[city_idx]["name"]
    district = CITY_PROFILES[city_idx]["district"]

    PROPERTIES.append({
        "name": name,
        "property_type": ptype,
        "city": city_name,
        "district": district,
        "address": addr,
        "description": (
            f"{name} is a wonderful {ptype} located in the heart of {city_name}, {CITY_PROFILES[city_idx]['state']}. "
            f"{CITY_PROFILES[city_idx]['desc']} "
            f"Our property offers comfortable accommodation with excellent amenities to make your stay "
            f"memorable. Explore the rich culture, cuisine, and attractions of {city_name} while enjoying "
            f"our warm hospitality and personalized service."
        ),
        "amenities": amenities,
        "rooms": [
            {
                "room_type": r[0],
                "base_price": r[1],
                "capacity_adults": r[2],
                "capacity_children": r[3],
                "total_quantity": r[4],
            }
            for r in rooms
        ],
    })

    # Generate rich documents for this property
    DOCUMENTS[name] = {}
    for dtype_key, title_suffix, gen_fn in _DOCUMENT_TYPES:
        DOCUMENTS[name][dtype_key] = gen_fn(name, city_idx)


# ── Helper functions (same as before) ──

def _get_or_create_rep(db, index):
    email = f"rep{index}@hotel.com"
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        return existing
    peppered = hmac.new(
        PEPPER.encode("utf-8"),
        b"password123",
        hashlib.sha256,
    ).hexdigest()
    hashed = bcrypt.hashpw(peppered.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    rep = User(
        email=email,
        password_hash=hashed,
        role=UserRole.hotel_rep,
        full_name=f"Hotel Rep {index}",
        phone=f"999999{index:04d}",
        is_active=True,
    )
    db.add(rep)
    db.flush()
    return rep


def _get_customer(db):
    email = "customer@test.com"
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        return existing
    peppered = hmac.new(
        PEPPER.encode("utf-8"),
        b"password123",
        hashlib.sha256,
    ).hexdigest()
    hashed = bcrypt.hashpw(peppered.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    cust = User(
        email=email,
        password_hash=hashed,
        role=UserRole.customer,
        full_name="Test Customer",
        phone="8888888888",
        is_active=True,
    )
    db.add(cust)
    db.flush()
    return cust


def _get_location(db, city_name, district_name):
    district = db.query(Location).filter(
        Location.name == district_name,
        Location.type == LocationType.district,
    ).first()
    if district:
        return district
    city = db.query(Location).filter(
        Location.name == city_name,
        Location.type == LocationType.city,
    ).first()
    if city:
        return city
    district = db.query(Location).filter(
        Location.name.ilike(district_name),
        Location.type == LocationType.district,
    ).first()
    if district:
        return district
    return None


def seed_data():
    db = SessionLocal()
    try:
        existing = db.query(Property).filter(Property.name == "The Imperial Palace").first()
        if existing:
            print("Seed data already exists. Skipping.")
            return

        customer = _get_customer(db)
        print(f"Customer: {customer.email}")

        for i, pdata in enumerate(PROPERTIES):
            rep = _get_or_create_rep(db, i + 1)
            loc = _get_location(db, pdata["city"], pdata["district"])
            if not loc:
                print(f"  Skipping {pdata['name']}: location {pdata['city']}/{pdata['district']} not found")
                continue

            prop = Property(
                name=pdata["name"],
                property_type=pdata["property_type"],
                description=pdata["description"],
                owner_rep_id=rep.id,
                city_id=loc.id if loc.type == LocationType.city else loc.parent_id,
                district_id=loc.id if loc.type == LocationType.district else None,
                address=pdata["address"],
                amenities=pdata["amenities"],
                is_approved=True,
                is_active=True,
            )
            db.add(prop)
            db.flush()
            print(f"  Property: {prop.name} (rep: {rep.email})")

            for rdata in pdata["rooms"]:
                room = Room(
                    property_id=prop.id,
                    room_type=rdata["room_type"],
                    base_price=rdata["base_price"],
                    capacity_adults=rdata["capacity_adults"],
                    capacity_children=rdata["capacity_children"],
                    total_quantity=rdata["total_quantity"],
                )
                db.add(room)
            db.flush()

            prop_docs = DOCUMENTS.get(pdata["name"], {})
            for dtype_key, title_suffix, gen_fn in _DOCUMENT_TYPES:
                text = prop_docs.get(dtype_key, "")
                if not text:
                    continue
                doc = PropertyDocument(
                    property_id=prop.id,
                    uploaded_by=rep.id,
                    doc_type=DocType(dtype_key),
                    title=f"{pdata['name']} — {title_suffix}",
                    file_url="",
                    summary_text=text,
                )
                db.add(doc)
            db.flush()

        # Create diverse reviews
        properties = db.query(Property).all()
        review_texts = [
            "Excellent stay! The rooms were clean and the staff incredibly friendly. Would definitely recommend to anyone visiting the area.",
            "Great location and beautiful property. The breakfast buffet had amazing variety with both local and international options.",
            "Good value for money. The room was comfortable but the AC could be quieter. Overall a pleasant experience.",
            "Amazing experience! The view from our room was breathtaking. Will definitely come again on our next trip.",
            "Decent hotel but needs some maintenance work. The pool was closed during our visit which was disappointing.",
            "Perfect for a family vacation. Kids loved the activities and the food was delicious. Very kid-friendly environment.",
            "The staff went above and beyond to help us plan our sightseeing. Their local knowledge was invaluable.",
            "Beautiful property with great amenities. The spa treatment was world-class and very reasonably priced.",
            "Room was smaller than expected but very clean and well-maintained. The location is very convenient for sightseeing.",
            "A truly romantic getaway. The candlelight dinner on the rooftop was unforgettable with stunning city views.",
            "Wonderful hospitality from check-in to check-out. The homemade meals were better than any restaurant we tried.",
            "Outstanding views and peaceful atmosphere. Perfect for a digital detox. Highly recommend the premium rooms.",
            "The architecture is stunning. Every corner has a story. Great for photography enthusiasts and history buffs.",
            "Best breakfast we have had anywhere in India. The local dishes were authentic and incredibly flavorful.",
            "Convenient for business travelers. The WiFi was fast and reliable, and the business center was well-equipped.",
            "The adventure activities organized by the hotel were the highlight of our trip. Perfectly managed and very safe.",
            "A bit overpriced for what you get, but the location makes up for it. Staff was courteous and professional.",
            "Incredible sunset views from the terrace. The evening cultural program featuring local performers was a bonus.",
            "Clean, safe, and well-maintained property. Perfect for solo female travelers. Felt very secure throughout our stay.",
            "The cooking class was the best part of our stay. We learned to make authentic local dishes from the chef himself.",
            "Loved the eco-friendly approach. Organic toiletries, farm-to-table dining, and zero plastic policy. Very impressed.",
            "The pool area was fantastic and well-maintained. Spent most of our time there. Great cocktails and prompt service.",
            "Night sky viewing was spectacular. Saw the Milky Way clearly from the rooftop. A truly magical experience.",
            "The guided city walk arranged by the hotel was the best way to explore the area. Learned so much local history.",
            "Checked in late at night and the staff was still incredibly warm and helpful. Five-star service all the way.",
            "The traditional music evening was a cultural treat. Authentic performances, not touristy at all. Very enjoyable.",
            "Room had a slight musty smell initially but housekeeping addressed it promptly. Otherwise everything was perfect.",
            "Best hotel gym we have used in India. Modern equipment and open 24 hours. Perfect for early morning workouts.",
            "The local guide recommendations from the concierge were spot on. Every restaurant they suggested was fantastic.",
            "Wish we had stayed longer. The property is so peaceful and relaxing that you lose track of time completely.",
            "The heritage walk arranged by the hotel gave us a completely different perspective on the city. Highly recommended.",
            "Excellent value for money. The all-inclusive package covered meals, activities, and transfers. Very convenient.",
            "The rooftop restaurant serves the best local cuisine we have ever tasted. The view is just the icing on the cake.",
            "Our room had a beautiful private balcony overlooking the garden. Perfect spot for morning tea and evening reading.",
            "The hotel arranged a surprise birthday cake for my partner. Such thoughtful service made our celebration special.",
            "Very impressed with the cleanliness standards. The rooms were spotless and housekeeping was prompt and thorough.",
            "The guided trek through the nearby hills was breathtaking. Our guide was knowledgeable and passionate about nature.",
            "Perfect base for exploring the region. The hotel helped us plan our entire itinerary. Everything went smoothly.",
            "The Ayurvedic spa treatments were authentic and rejuvenating. The therapist was highly skilled and professional.",
            "Great family-run property with personalized attention. Felt like visiting relatives rather than staying at a hotel.",
            "The local craft workshop organized by the hotel was a unique experience. We made our own souvenirs to take home.",
            "Outstanding service throughout our 5-night stay. Every staff member remembered our names and preferences.",
            "The hotel's garden is a hidden paradise. Beautiful flowers, chirping birds, and a peaceful koi pond. Very relaxing.",
            "Excellent location within walking distance of all major attractions. Saved a lot on transportation costs.",
            "The complimentary city tour was a nice touch. Our guide was friendly, knowledgeable, and very patient with questions.",
            "Really appreciated the late check-out option. Allowed us to explore the city on our last day without rushing.",
            "The hotel arranged a private car with driver for our entire stay. Very reasonable rates and excellent service.",
            "Beautifully restored heritage property with modern amenities. The perfect blend of old-world charm and comfort.",
            "The cooking demonstration followed by lunch was a highlight. Learned family recipes passed down through generations.",
        ]
        ratings = [5, 5, 4, 5, 3, 5, 5, 5, 3, 5, 5, 5, 4, 5, 4, 5, 3, 5, 5, 5, 5, 4, 5, 4, 5, 5, 3, 4, 5, 5, 5, 4, 5, 5, 5, 5, 4, 5, 5, 5, 5, 5, 5, 5, 4, 5, 5, 5, 5]
        for i, prop in enumerate(properties):
            rooms = db.query(Room).filter(Room.property_id == prop.id).all()
            if not rooms:
                continue
            num_reviews = 2 + (i % 4)
            for j in range(num_reviews):
                idx = (i * 5 + j) % len(review_texts)
                room = rooms[j % len(rooms)]
                check_in = date.today() - timedelta(days=30 + j * 5)
                check_out = check_in + timedelta(days=2)
                booking = Booking(
                    customer_id=customer.id,
                    room_id=room.id,
                    check_in=check_in,
                    check_out=check_out,
                    num_adults=2,
                    num_children=0,
                    status=BookingStatus.completed,
                    total_price=room.base_price * 2,
                )
                db.add(booking)
                db.flush()
                review = Review(
                    booking_id=booking.id,
                    property_id=prop.id,
                    customer_id=customer.id,
                    rating=ratings[idx],
                    comment=review_texts[idx],
                )
                db.add(review)
            db.flush()

        db.commit()
        total_props = db.query(Property).count()
        total_rooms = db.query(Room).count()
        total_docs = db.query(PropertyDocument).count()
        total_reviews = db.query(Review).count()
        print(f"\nSeeded: {total_props} properties, {total_rooms} rooms, {total_docs} documents, {total_reviews} reviews")
        print("Run 'POST /api/rag/reindex' to generate embeddings for semantic search.")

    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed_data()
